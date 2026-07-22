import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  BaseCheckpointSaver,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { CreateForkInput, ForkManifest } from "../workspace/format.ts";
import { repositoryCheckpointIdentity } from "../persistence/checkpoint-thread-codec.ts";
import type { ArtifactRef } from "../evidence/types.ts";
import { WorktreeManager } from "../workspace/worktree-manager.ts";
import { validateThreadId } from "./runtime-control.ts";

export interface ForkWorkflowCheckpointInput extends CreateForkInput {
  readonly checkpointer: BaseCheckpointSaver;
  readonly worktreeManager: WorktreeManager;
  readonly retainArtifacts?: (forkThreadId: string, refs: readonly ArtifactRef[]) => Promise<void>;
}

export class WorkflowForkError extends Error {
  readonly name = "WorkflowForkError";
}

interface PendingWriteBatchSaver {
  putWritesBatch(
    config: RunnableConfig,
    groups: readonly { readonly taskId: string; readonly writes: PendingWrite[] }[],
  ): Promise<void>;
}

export async function forkWorkflowCheckpoint(input: ForkWorkflowCheckpointInput): Promise<ForkManifest> {
  validateThreadId(input.sourceThreadId);
  validateThreadId(input.forkThreadId);
  validateCheckpointId(input.checkpointId);
  const target = threadConfig(input.forkThreadId);
  if (await input.checkpointer.getTuple(target) !== undefined) {
    throw new WorkflowForkError(`fork thread already has checkpoints: ${input.forkThreadId}`);
  }
  const source = await input.checkpointer.getTuple(checkpointConfig(input.sourceThreadId, input.checkpointId));
  if (source === undefined || source.checkpoint.id !== input.checkpointId) {
    throw new WorkflowForkError(`source checkpoint does not exist: ${input.checkpointId}`);
  }
  if (source.metadata === undefined) throw new WorkflowForkError("source checkpoint metadata is missing");
  const repository = repositoryCheckpointIdentity(source.metadata);
  if (repository?.head !== input.gitCommit) {
    throw new WorkflowForkError("Git commit is not bound to the selected checkpoint repository snapshot");
  }
  const checkpoints = await checkpointTree(input.checkpointer, input.sourceThreadId, source);

  const manifest = await input.worktreeManager.createFork(input);
  try {
    for (const entry of checkpoints) {
      const metadata = entry.metadata;
      if (metadata === undefined) throw new WorkflowForkError("source checkpoint metadata is missing");
      const namespace = checkpointNamespace(entry);
      const storedConfig = await input.checkpointer.put(
        targetConfig(input.forkThreadId, namespace, parentCheckpointId(entry)),
        entry.checkpoint,
        forkMetadata(metadata),
        entry.checkpoint.channel_versions,
      );
      await copyPendingWrites(input.checkpointer, storedConfig, entry.pendingWrites ?? []);
    }
    await input.retainArtifacts?.(input.forkThreadId, checkpointArtifacts(checkpoints));
    return manifest;
  } catch (error) {
    await input.checkpointer.deleteThread(input.forkThreadId);
    await input.worktreeManager.cleanup(input.forkThreadId);
    throw error;
  }
}

function checkpointConfig(threadId: string, checkpointId: string): RunnableConfig {
  return { configurable: { thread_id: threadId, checkpoint_id: checkpointId } };
}

function threadConfig(threadId: string): RunnableConfig {
  return { configurable: { thread_id: threadId } };
}

function targetConfig(threadId: string, namespace: string, parentId: string | undefined): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: namespace,
      ...(parentId === undefined ? {} : { checkpoint_id: parentId }),
    },
  };
}

function forkMetadata(metadata: CheckpointMetadata): CheckpointMetadata {
  return { ...metadata, source: "fork" };
}

async function checkpointTree(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  root: CheckpointTuple,
): Promise<readonly CheckpointTuple[]> {
  const candidates = new Map<string, CheckpointTuple>();
  for await (const tuple of checkpointer.list(threadConfig(threadId))) candidates.set(checkpointKey(tuple), tuple);
  candidates.set(checkpointKey(root), root);
  const selected: CheckpointTuple[] = [];
  const visited = new Set<string>();
  const visit = async (tuple: CheckpointTuple): Promise<void> => {
    const key = checkpointKey(tuple);
    if (visited.has(key)) return;
    visited.add(key);
    for (const parent of checkpointParents(tuple)) {
      const candidate = candidates.get(parent);
      if (candidate !== undefined) await visit(await checkpointer.getTuple(candidate.config) ?? candidate);
    }
    selected.push(tuple);
  };
  await visit(root);
  return selected;
}

function checkpointParents(tuple: CheckpointTuple): readonly string[] {
  const parents = Object.entries(tuple.metadata?.parents ?? {}).map(([namespace, checkpointId]) => keyText(namespace, checkpointId));
  const parentId = tuple.parentConfig?.configurable?.checkpoint_id;
  const namespace = tuple.parentConfig?.configurable?.checkpoint_ns;
  return typeof parentId === "string"
    ? [...parents, keyText(typeof namespace === "string" ? namespace : checkpointNamespace(tuple), parentId)]
    : parents;
}

function checkpointArtifacts(checkpoints: readonly CheckpointTuple[]): readonly ArtifactRef[] {
  const refs = new Map<string, ArtifactRef>();
  for (const tuple of checkpoints) {
    const value = tuple.checkpoint.channel_values.evidenceRefs;
    if (!Array.isArray(value)) continue;
    for (const ref of value) {
      if (typeof ref !== "object" || ref === null || !("digest" in ref) || typeof ref.digest !== "string" ||
        !("byteCount" in ref) || typeof ref.byteCount !== "number" || !("truncated" in ref) || typeof ref.truncated !== "boolean") continue;
      refs.set(ref.digest, { digest: ref.digest, byteCount: ref.byteCount, truncated: ref.truncated });
    }
  }
  return [...refs.values()];
}

function checkpointNamespace(tuple: CheckpointTuple): string {
  const namespace = tuple.config.configurable?.checkpoint_ns;
  return typeof namespace === "string" ? namespace : "";
}

function parentCheckpointId(tuple: CheckpointTuple): string | undefined {
  const checkpointId = tuple.parentConfig?.configurable?.checkpoint_id;
  return typeof checkpointId === "string" ? checkpointId : undefined;
}

function checkpointKey(tuple: CheckpointTuple): string {
  return keyText(checkpointNamespace(tuple), tuple.checkpoint.id);
}

function keyText(namespace: string, checkpointId: string): string {
  return JSON.stringify([namespace, checkpointId]);
}

async function copyPendingWrites(
  checkpointer: BaseCheckpointSaver,
  config: RunnableConfig,
  writes: readonly [string, string, unknown][],
): Promise<void> {
  const grouped = new Map<string, PendingWrite[]>();
  for (const [taskId, channel, value] of writes) {
    const current = grouped.get(taskId) ?? [];
    current.push([channel, value]);
    grouped.set(taskId, current);
  }
  const groups = [...grouped].map(([taskId, pending]) => ({ taskId, writes: pending }));
  const portable = groups.filter((group) => !group.writes.some(([channel]) => channel === "__interrupt__"));
  if (supportsWriteBatch(checkpointer)) {
    await checkpointer.putWritesBatch(config, portable);
    return;
  }
  for (const group of portable) await checkpointer.putWrites(config, group.writes, group.taskId);
}

function supportsWriteBatch(checkpointer: BaseCheckpointSaver): checkpointer is BaseCheckpointSaver & PendingWriteBatchSaver {
  return "putWritesBatch" in checkpointer && typeof checkpointer.putWritesBatch === "function";
}

function validateCheckpointId(checkpointId: string): void {
  if (checkpointId.length === 0 || checkpointId.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(checkpointId)) {
    throw new WorkflowForkError("checkpointId is invalid");
  }
}

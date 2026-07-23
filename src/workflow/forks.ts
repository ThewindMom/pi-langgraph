import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  BaseCheckpointSaver,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { CreateForkInput, ForkManifest } from "../workspace/format.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
  type ReplaySafetyContext,
  type RepositoryCheckpointIdentity,
} from "../persistence/checkpoint-thread-codec.ts";
import type { ArtifactRef } from "../evidence/types.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import { WorktreeManager } from "../workspace/worktree-manager.ts";
import { validateThreadId } from "./runtime-control.ts";

export interface ForkWorkflowCheckpointInput extends CreateForkInput {
  readonly checkpointer: BaseCheckpointSaver;
  readonly worktreeManager: WorktreeManager;
  readonly snapshotStore?: RepositorySnapshotStore;
  readonly retainArtifacts?: (forkThreadId: string, refs: readonly ArtifactRef[]) => Promise<void>;
}

export interface CloneWorkflowCheckpointInput {
  readonly checkpointer: BaseCheckpointSaver;
  readonly sourceThreadId: string;
  readonly checkpointId: string;
  readonly forkThreadId: string;
  readonly retainArtifacts?: (forkThreadId: string, refs: readonly ArtifactRef[]) => Promise<void>;
}

export class WorkflowForkError extends Error {
  readonly name = "WorkflowForkError";
}

interface ReplayBindingCheckpointSaver extends BaseCheckpointSaver {
  bindRepositorySnapshot(threadId: string, identity: RepositoryCheckpointIdentity): void;
  bindReplaySafety(threadId: string, context: ReplaySafetyContext): void;
}

interface PendingWriteBatchSaver {
  putWritesBatch(config: RunnableConfig, groups: readonly { readonly taskId: string; readonly writes: PendingWrite[] }[]): Promise<void>;
}

export async function forkWorkflowCheckpoint(input: ForkWorkflowCheckpointInput): Promise<ForkManifest> {
  const prepared = await prepareClone(input, false);
  const source = prepared.checkpoints.at(-1);
  if (source === undefined) throw new WorkflowForkError(`source checkpoint does not exist: ${input.checkpointId}`);
  if (source.metadata === undefined) throw new WorkflowForkError("source checkpoint metadata is missing");
  const repository = repositoryCheckpointIdentity(source.metadata);
  if (repository?.head !== input.gitCommit) {
    throw new WorkflowForkError("Git commit is not bound to the selected checkpoint repository snapshot");
  }

  const manifest = await input.worktreeManager.createFork(input);
  try {
    const forkSnapshot = await input.snapshotStore?.capture(manifest.workspacePath);
    bindForkReplay(input.checkpointer, input.forkThreadId, source.metadata, forkSnapshot === undefined
      ? undefined
      : {
        protocolVersion: 1,
        snapshotId: forkSnapshot.snapshotId,
        head: forkSnapshot.baselineHead,
      });
    await copyPreparedClone(input, prepared);
    return manifest;
  } catch (error) {
    await input.checkpointer.deleteThread(input.forkThreadId);
    await input.worktreeManager.cleanup(input.forkThreadId);
    throw error;
  }
}

function bindForkReplay(
  checkpointer: BaseCheckpointSaver,
  forkThreadId: string,
  metadata: CheckpointMetadata,
  forkRepository?: RepositoryCheckpointIdentity,
): void {
  if (!supportsReplayBindings(checkpointer)) return;
  const repository = forkRepository ?? repositoryCheckpointIdentity(metadata);
  const replay = checkpointReplayMetadata(metadata)?.replayBinding;
  if (repository === undefined || replay === undefined) return;
  checkpointer.bindRepositorySnapshot(forkThreadId, repository);
  checkpointer.bindReplaySafety(forkThreadId, {
    bridgeProtocolVersion: replay.bridgeProtocolVersion,
    workflowVersion: replay.workflowVersion,
    stateVersion: replay.stateVersion,
    workflowInput: replay.workflowInput,
    toolModelConfigDigest: replay.toolModelConfigDigest,
    effectLedgerDigest: replay.effectLedgerDigest,
  });
}

function supportsReplayBindings(
  checkpointer: BaseCheckpointSaver,
): checkpointer is ReplayBindingCheckpointSaver {
  return "bindRepositorySnapshot" in checkpointer && typeof checkpointer.bindRepositorySnapshot === "function" &&
    "bindReplaySafety" in checkpointer && typeof checkpointer.bindReplaySafety === "function";
}

export async function cloneWorkflowCheckpoint(input: CloneWorkflowCheckpointInput): Promise<void> {
  const prepared = await prepareClone(input, true);
  try {
    if (prepared.targetPopulated) await input.checkpointer.deleteThread(input.forkThreadId);
    await copyPreparedClone(input, prepared);
  } catch (error) {
    await input.checkpointer.deleteThread(input.forkThreadId);
    throw error;
  }
}

type PreparedClone = Readonly<{ checkpoints: readonly CheckpointTuple[]; targetPopulated: boolean }>;

async function prepareClone(
  input: CloneWorkflowCheckpointInput,
  allowOwnedResume: boolean,
): Promise<PreparedClone> {
  validateThreadId(input.sourceThreadId);
  validateThreadId(input.forkThreadId);
  validateCheckpointId(input.checkpointId);
  const existing: CheckpointTuple[] = [];
  for await (const tuple of input.checkpointer.list(threadConfig(input.forkThreadId))) existing.push(tuple);
  if (!allowOwnedResume && existing.length > 0) {
    throw new WorkflowForkError(`fork thread already has checkpoints: ${input.forkThreadId}`);
  }
  const source = await input.checkpointer.getTuple(checkpointConfig(input.sourceThreadId, input.checkpointId));
  if (source === undefined || source.checkpoint.id !== input.checkpointId) {
    throw new WorkflowForkError(`source checkpoint does not exist: ${input.checkpointId}`);
  }
  const checkpoints = await checkpointTree(input.checkpointer, input.sourceThreadId, source);
  const expected = new Set(checkpoints.map(checkpointKey));
  if (existing.some((tuple) => !expected.has(checkpointKey(tuple)))) {
    throw new WorkflowForkError(`fork thread has unrelated checkpoints: ${input.forkThreadId}`);
  }
  return { checkpoints, targetPopulated: existing.length > 0 };
}

async function copyPreparedClone(
  input: CloneWorkflowCheckpointInput,
  prepared: PreparedClone,
): Promise<void> {
  for (const entry of prepared.checkpoints) {
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
  await input.retainArtifacts?.(input.forkThreadId, checkpointArtifacts(prepared.checkpoints));
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

import type { RunnableConfig } from "@langchain/core/runnables";
import type { Checkpoint, CheckpointMetadata, MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  ReplayCompatibilityError,
  parseReplayFingerprintBinding,
  replayFingerprint,
  type ReplayFingerprintBinding,
} from "../workflow/replay-compatibility.ts";
import { isRecord } from "./file-checkpoint-format.ts";
import {
  SEMANTIC_CHECKPOINT_LABELS,
  semanticCheckpointLabels,
  type SemanticCheckpointLabel,
} from "./workflow-state-validation.ts";

export type RepositoryCheckpointIdentity = Readonly<{
  protocolVersion: 1;
  snapshotId: string;
  head: string | null;
}>;

export type ReplaySafetyContext = Omit<
  ReplayFingerprintBinding,
  "checkpoint" | "repositorySnapshot"
>;

export type CheckpointReplayMetadata = Readonly<{
  version: 1;
  semanticLabels: readonly SemanticCheckpointLabel[];
  replayBinding?: ReplayFingerprintBinding;
  replayFingerprint?: string;
}>;

type StoredMetadataInput = Readonly<{
  memory: MemorySaver;
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  threadId: string;
}>;

const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export class CheckpointMetadataBindings {
  private readonly repositorySnapshots = new Map<string, RepositoryCheckpointIdentity>();
  private readonly replaySafety = new Map<string, ReplaySafetyContext>();

  bindRepositorySnapshot(threadId: string, identity: RepositoryCheckpointIdentity): void {
    this.repositorySnapshots.set(threadId, identity);
  }

  bindReplaySafety(threadId: string, context: ReplaySafetyContext): void {
    this.replaySafety.set(threadId, context);
  }

  clear(threadId: string): void {
    this.repositorySnapshots.delete(threadId);
    this.replaySafety.delete(threadId);
  }

  storedMetadata(input: StoredMetadataInput): CheckpointMetadata {
    const repositorySnapshot = this.repositorySnapshots.get(input.threadId);
    const replaySafety = this.replaySafety.get(input.threadId);
    const namespace = typeof input.config.configurable?.checkpoint_ns === "string"
      ? input.config.configurable.checkpoint_ns
      : "";
    const piLangGraph = namespace === "" ? createCheckpointReplayMetadata({
      memory: input.memory,
      config: input.config,
      checkpointId: input.checkpoint.id,
      channelValues: input.checkpoint.channel_values,
      threadId: input.threadId,
      ...(repositorySnapshot === undefined ? {} : { repositorySnapshot }),
      ...(replaySafety === undefined ? {} : { replaySafety }),
    }) : undefined;
    return {
      ...input.metadata,
      ...(repositorySnapshot === undefined ? {} : { repositorySnapshot }),
      ...(piLangGraph === undefined ? {} : { piLangGraph }),
    };
  }
}

export function repositoryCheckpointIdentity(metadata: unknown): RepositoryCheckpointIdentity | undefined {
  if (typeof metadata !== "object" || metadata === null || !("repositorySnapshot" in metadata)) return undefined;
  const value: unknown = metadata.repositorySnapshot;
  if (typeof value !== "object" || value === null ||
    !("protocolVersion" in value) || value.protocolVersion !== 1 ||
    !("snapshotId" in value) || typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId) ||
    !("head" in value) || (value.head !== null && (typeof value.head !== "string" || !GIT_OBJECT_ID.test(value.head)))) {
    throw new Error("invalid checkpoint repository snapshot identity");
  }
  return { protocolVersion: 1, snapshotId: value.snapshotId, head: value.head };
}

export function checkpointReplayMetadata(metadata: unknown): CheckpointReplayMetadata | undefined {
  if (!isRecord(metadata) || !("piLangGraph" in metadata)) return undefined;
  const value = metadata.piLangGraph;
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.semanticLabels)) {
    throw new ReplayCompatibilityError("invalid pi-langgraph checkpoint metadata");
  }
  const semanticLabels = value.semanticLabels.flatMap((label) => isSemanticCheckpointLabel(label) ? [label] : []);
  const canonical = SEMANTIC_CHECKPOINT_LABELS.filter((label) => semanticLabels.includes(label));
  if (
    semanticLabels.length !== value.semanticLabels.length ||
    canonical.length !== semanticLabels.length ||
    canonical.some((label, index) => semanticLabels[index] !== label)
  ) {
    throw new ReplayCompatibilityError("invalid semantic checkpoint labels");
  }
  const hasBinding = "replayBinding" in value;
  const hasFingerprint = "replayFingerprint" in value;
  const expectedFields = hasBinding || hasFingerprint
    ? ["version", "semanticLabels", "replayBinding", "replayFingerprint"]
    : ["version", "semanticLabels"];
  if (Object.keys(value).length !== expectedFields.length || expectedFields.some((field) => !(field in value))) {
    throw new ReplayCompatibilityError("invalid pi-langgraph checkpoint metadata fields");
  }
  if (!hasBinding) return { version: 1, semanticLabels: canonical };
  const replayBinding = parseReplayFingerprintBinding(value.replayBinding);
  const fingerprint = value.replayFingerprint;
  if (typeof fingerprint !== "string" || replayFingerprint(replayBinding) !== fingerprint) {
    throw new ReplayCompatibilityError("checkpoint replay fingerprint does not match its binding");
  }
  return { version: 1, semanticLabels: canonical, replayBinding, replayFingerprint: fingerprint };
}

type ReplayMetadataInput = Readonly<{
  memory: MemorySaver;
  config: RunnableConfig;
  checkpointId: string;
  channelValues: Readonly<Record<string, unknown>>;
  threadId: string;
  repositorySnapshot?: RepositoryCheckpointIdentity;
  replaySafety?: ReplaySafetyContext;
}>;

function createCheckpointReplayMetadata(input: ReplayMetadataInput): CheckpointReplayMetadata {
  const semanticLabels = semanticCheckpointLabels(input.channelValues);
  if (input.replaySafety === undefined) return { version: 1, semanticLabels };
  if (input.repositorySnapshot === undefined) {
    throw new ReplayCompatibilityError("replay safety requires a bound repository snapshot");
  }
  const namespace = typeof input.config.configurable?.checkpoint_ns === "string"
    ? input.config.configurable.checkpoint_ns
    : "";
  const parentId = input.config.configurable?.checkpoint_id;
  const lineage = checkpointLineage(
    input.memory,
    {
      threadId: input.threadId,
      namespace,
      checkpointId: input.checkpointId,
      ...(typeof parentId === "string" ? { parentId } : {}),
    },
  );
  const replayBinding = parseReplayFingerprintBinding({
    ...input.replaySafety,
    checkpoint: { threadId: input.threadId, checkpointId: input.checkpointId, lineage },
    repositorySnapshot: {
      snapshotId: input.repositorySnapshot.snapshotId,
      baselineHead: input.repositorySnapshot.head,
    },
  });
  return {
    version: 1,
    semanticLabels,
    replayBinding,
    replayFingerprint: replayFingerprint(replayBinding),
  };
}

type CheckpointLineageInput = Readonly<{
  threadId: string;
  namespace: string;
  parentId?: string;
  checkpointId: string;
}>;

function checkpointLineage(memory: MemorySaver, input: CheckpointLineageInput): readonly string[] {
  const reversed: string[] = [];
  const visited = new Set<string>();
  let current = input.parentId;
  const checkpoints = memory.storage[input.threadId]?.[input.namespace];
  while (current !== undefined) {
    if (visited.has(current)) throw new ReplayCompatibilityError("checkpoint lineage contains a cycle");
    visited.add(current);
    reversed.push(current);
    const entry = checkpoints?.[current];
    if (entry === undefined) throw new ReplayCompatibilityError("checkpoint lineage references a missing parent");
    current = entry[2];
  }
  return [...reversed.reverse(), input.checkpointId];
}

function isSemanticCheckpointLabel(value: unknown): value is SemanticCheckpointLabel {
  return typeof value === "string" && SEMANTIC_CHECKPOINT_LABELS.some((label) => label === value);
}

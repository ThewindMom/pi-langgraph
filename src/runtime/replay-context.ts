import { BRIDGE_PROTOCOL_VERSION } from "../bridge/types.ts";
import { sha256CanonicalJson } from "../bridge/canonical.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
  type ReplaySafetyContext,
} from "../persistence/checkpoint-thread-codec.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import type {
  RepositorySnapshotStore,
  StoredRepositorySnapshot,
} from "../repository/repository-snapshot-store.ts";
import {
  effectLedgerDigest,
  type EffectLedger,
} from "../workflow/effect-ledger.ts";
import {
  ReplayCompatibilityError,
  replayFingerprint,
  type ReplayFingerprintBinding,
} from "../workflow/replay-compatibility.ts";
import type { RepositoryExecutionPolicy } from "./repository-services.ts";

export const WORKFLOW_REPLAY_VERSION = 1 as const;
export const WORKFLOW_STATE_VERSION = 1 as const;

export type ReplayResumeRejectionReason =
  | "missing-checkpoint"
  | "missing-replay-metadata"
  | "invalid-replay-metadata"
  | "graph-version-mismatch"
  | "checkpoint-lineage-mismatch"
  | "tool-model-config-mismatch"
  | "active-link-mismatch"
  | "active-checkpoint-requires-fork"
  | "active-worktree-mismatch"
  | "repository-mismatch"
  | "effect-ledger-mismatch"
  | "fingerprint-mismatch";

export class ReplayResumeRejectedError extends Error {
  readonly name = "ReplayResumeRejectedError";

  constructor(readonly reason: ReplayResumeRejectionReason) {
    super(`workflow resume rejected: ${reason}`);
  }
}

export type BindNewWorkflowReplayInput = Readonly<{
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  threadId: string;
  sourceDirectory: string;
  workflowInput: unknown;
  policy: RepositoryExecutionPolicy;
  effectLedger: EffectLedger;
}>;

export type BoundWorkflowReplay = Readonly<{
  snapshot: StoredRepositorySnapshot;
  replaySafety: ReplaySafetyContext;
}>;

export async function bindNewWorkflowReplay(
  input: BindNewWorkflowReplayInput,
): Promise<BoundWorkflowReplay> {
  const snapshot = await input.snapshotStore.capture(input.sourceDirectory);
  const replaySafety = replaySafetyContext(input.workflowInput, input.policy, input.effectLedger);
  input.checkpoints.bindRepositorySnapshot(input.threadId, {
    protocolVersion: 1,
    snapshotId: snapshot.snapshotId,
    head: snapshot.baselineHead,
  });
  input.checkpoints.bindReplaySafety(input.threadId, replaySafety);
  return { snapshot, replaySafety };
}

export type AssertResumeReplayInput = Omit<
  BindNewWorkflowReplayInput,
  "workflowInput"
>;

export async function assertResumeReplayCompatible(
  input: AssertResumeReplayInput,
): Promise<ReplayFingerprintBinding> {
  const tuple = await input.checkpoints.getTuple({
    configurable: { thread_id: input.threadId },
  });
  if (tuple === undefined) reject("missing-checkpoint");
  let metadata;
  try {
    metadata = checkpointReplayMetadata(tuple.metadata);
  } catch (error) {
    if (error instanceof ReplayCompatibilityError) reject("invalid-replay-metadata");
    throw error;
  }
  const binding = metadata?.replayBinding;
  if (binding === undefined || metadata?.replayFingerprint === undefined) {
    reject("missing-replay-metadata");
  }
  if (
    binding.bridgeProtocolVersion !== BRIDGE_PROTOCOL_VERSION ||
    binding.workflowVersion !== WORKFLOW_REPLAY_VERSION ||
    binding.stateVersion !== WORKFLOW_STATE_VERSION
  ) {
    reject("graph-version-mismatch");
  }
  if (
    binding.checkpoint.threadId !== input.threadId ||
    binding.checkpoint.checkpointId !== tuple.checkpoint.id ||
    binding.checkpoint.lineage.at(-1) !== tuple.checkpoint.id
  ) {
    reject("checkpoint-lineage-mismatch");
  }
  if (binding.toolModelConfigDigest !== toolModelConfigDigest(input.policy)) {
    reject("tool-model-config-mismatch");
  }
  if (binding.effectLedgerDigest !== effectLedgerDigest(input.effectLedger)) {
    reject("effect-ledger-mismatch");
  }
  const current = await input.snapshotStore.capture(input.sourceDirectory);
  const persistedRepository = repositoryCheckpointIdentity(tuple.metadata);
  if (
    binding.repositorySnapshot.snapshotId !== current.snapshotId ||
    binding.repositorySnapshot.baselineHead !== current.baselineHead ||
    persistedRepository?.snapshotId !== current.snapshotId ||
    persistedRepository.head !== current.baselineHead
  ) {
    reject("repository-mismatch");
  }
  if (
    replayFingerprint(binding) !== metadata.replayFingerprint
  ) {
    reject("fingerprint-mismatch");
  }
  return binding;
}

export function replaySafetyContext(
  workflowInput: unknown,
  policy: RepositoryExecutionPolicy,
  ledger: EffectLedger,
): ReplaySafetyContext {
  return {
    bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    workflowVersion: WORKFLOW_REPLAY_VERSION,
    stateVersion: WORKFLOW_STATE_VERSION,
    workflowInput,
    toolModelConfigDigest: toolModelConfigDigest(policy),
    effectLedgerDigest: effectLedgerDigest(ledger),
  };
}

export function toolModelConfigDigest(policy: RepositoryExecutionPolicy): string {
  return sha256CanonicalJson({
    graph: "pi-langgraph-coding-workflow",
    checkpointDurability: "sync",
    workflowVersion: WORKFLOW_REPLAY_VERSION,
    stateVersion: WORKFLOW_STATE_VERSION,
    policy: {
      adapter: policy.adapter,
      inheritedModel: policy.inheritedModel,
      activeTools: [...new Set(policy.activeTools)].sort(),
      protocol: policy.protocol,
    },
  });
}

function reject(reason: ReplayResumeRejectionReason): never {
  throw new ReplayResumeRejectedError(reason);
}

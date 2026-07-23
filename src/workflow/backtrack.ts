import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import type { BacktrackRequestV1, RepositorySnapshotId, SessionCheckpointLinkV1 } from "../bridge/types.ts";
import { checkpointReplayMetadata, repositoryCheckpointIdentity } from "../persistence/checkpoint-thread-codec.ts";
import { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { createRepositorySnapshot } from "../repository/snapshot.ts";
import { assessAutomaticBacktrackSafety, effectLedgerDigest, type EffectLedger } from "./effect-ledger.ts";
import { ReplayCompatibilityError, replayFingerprint } from "./replay-compatibility.ts";

const CANDIDATE_IDS = ["candidate-0", "candidate-1"] as const;

export type BacktrackPreflightInput = Readonly<{
  checkpoints: FileCheckpointSaver;
  sourceDirectory: string;
  effectLedger: EffectLedger;
  snapshotExists: (snapshotId: RepositorySnapshotId) => Promise<boolean>;
}>;

export type BacktrackPreflightResult =
  | Readonly<{
    kind: "accepted";
    requestId: BacktrackRequestV1["requestId"];
    link: SessionCheckpointLinkV1;
    checkpointId: BacktrackRequestV1["link"]["checkpointId"];
    threadId: BacktrackRequestV1["link"]["threadId"];
    targetCheckpointSnapshotId: RepositorySnapshotId;
    sourceSnapshotIdAtAcceptance: string;
    replayFingerprint: BacktrackRequestV1["link"]["replayFingerprint"];
    candidateIds: typeof CANDIDATE_IDS;
  }>
  | Readonly<{ kind: "incompatible"; requestId: BacktrackRequestV1["requestId"] }>
  | Readonly<{ kind: "blocked_effect"; requestId: BacktrackRequestV1["requestId"] }>
  | Readonly<{ kind: "source_changed"; requestId: BacktrackRequestV1["requestId"] }>
  | Readonly<{ kind: "missing_checkpoint"; requestId: BacktrackRequestV1["requestId"] }>
  | Readonly<{ kind: "already_terminal"; requestId: BacktrackRequestV1["requestId"] }>;

export async function preflightBacktrack(
  request: BacktrackRequestV1,
  input: BacktrackPreflightInput,
): Promise<BacktrackPreflightResult> {
  const tuple = await input.checkpoints.getTuple(checkpointConfig(request));
  if (tuple === undefined || tuple.checkpoint.id !== request.link.checkpointId) return rejected(request, "missing_checkpoint");
  if (tuple.checkpoint.channel_values.status === "completed") {
    return rejected(request, "already_terminal");
  }
  if (!hasCompatibleReplay(tuple, request.link) || effectLedgerDigest(input.effectLedger) !== request.link.effectLedgerDigest) {
    return rejected(request, "incompatible");
  }
  if (assessAutomaticBacktrackSafety(input.effectLedger).kind !== "safe") return rejected(request, "blocked_effect");
  if (!await input.snapshotExists(request.link.repositorySnapshot.snapshotId)) return rejected(request, "incompatible");
  const source = await createRepositorySnapshot(input.sourceDirectory);
  if (source.head !== request.link.repositorySnapshot.baselineHead) {
    return rejected(request, "source_changed");
  }
  return {
    kind: "accepted", requestId: request.requestId, link: request.link,
    checkpointId: request.link.checkpointId, threadId: request.link.threadId,
    targetCheckpointSnapshotId: request.link.repositorySnapshot.snapshotId,
    sourceSnapshotIdAtAcceptance: source.snapshotId,
    replayFingerprint: request.link.replayFingerprint, candidateIds: CANDIDATE_IDS,
  };
}

function checkpointConfig(request: BacktrackRequestV1): Readonly<{ configurable: Readonly<{ thread_id: string; checkpoint_id: string }> }> {
  return { configurable: { thread_id: request.link.threadId, checkpoint_id: request.link.checkpointId } };
}

function hasCompatibleReplay(tuple: CheckpointTuple, link: SessionCheckpointLinkV1): boolean {
  try {
    const metadata = checkpointReplayMetadata(tuple.metadata);
    if (metadata === undefined || metadata.replayBinding === undefined || metadata.replayFingerprint === undefined) {
      return false;
    }
    const binding = metadata?.replayBinding;
    const repository = repositoryCheckpointIdentity(tuple.metadata);
    return binding.checkpoint.threadId === link.threadId && binding.checkpoint.checkpointId === link.checkpointId &&
      binding.checkpoint.lineage.at(-1) === link.checkpointId &&
      binding.repositorySnapshot.snapshotId === link.repositorySnapshot.snapshotId &&
      binding.repositorySnapshot.baselineHead === link.repositorySnapshot.baselineHead &&
      binding.effectLedgerDigest === link.effectLedgerDigest &&
      repository?.snapshotId === link.repositorySnapshot.snapshotId && repository.head === link.repositorySnapshot.baselineHead &&
      metadata.replayFingerprint === link.replayFingerprint && replayFingerprint(binding) === link.replayFingerprint;
  } catch (error) {
    if (error instanceof ReplayCompatibilityError) return false;
    throw error;
  }
}

function rejected(
  request: BacktrackRequestV1,
  kind: Exclude<BacktrackPreflightResult["kind"], "accepted">,
): BacktrackPreflightResult {
  return { kind, requestId: request.requestId };
}

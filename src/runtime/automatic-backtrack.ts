import { join } from "node:path";
import { sha256CanonicalJson } from "../bridge/canonical.ts";
import {
  BRIDGE_PROTOCOL_VERSION,
  PI_CHECKPOINT_LINK_ENTRY_TYPE,
  type BacktrackRequestV1,
  type SessionCheckpointLinkV1,
} from "../bridge/types.ts";
import { checkpointReplayMetadata } from "../persistence/checkpoint-thread-codec.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { CandidatePromotion } from "../repository/candidate-promotion.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import { CandidateWorktreeManager } from "../workspace/candidate-worktree-manager.ts";
import {
  BacktrackCoordinator,
  type BacktrackCoordinatorOutcome,
  type CandidateRunner,
} from "../workflow/backtrack-coordinator.ts";
import type { CandidateTieCritic } from "../workflow/candidate-scoring.ts";
import { preflightBacktrack } from "../workflow/backtrack.ts";
import {
  assessAutomaticBacktrackSafety,
  type EffectLedger,
} from "../workflow/effect-ledger.ts";
import { ReplayCompatibilityError } from "../workflow/replay-compatibility.ts";
import type { CodingRunResult, CodingWorkflowResult } from "../workflow/types.ts";
import {
  automaticBacktrackDecision,
  isStructuredFailedDelivery,
} from "./automatic-backtrack-policy.ts";

export type AutomaticBacktrackNeedsAttentionReason =
  | "not-a-failed-delivery"
  | "review-objective"
  | "awaiting-approval"
  | "unsafe-effects"
  | "incompatible-replay"
  | "source-changed"
  | "missing-checkpoint"
  | "already-terminal"
  | "manual-escalation";

export type AutomaticBacktrackResult =
  | BacktrackCoordinatorOutcome
  | Readonly<{
    kind: "needs_attention";
    reason: AutomaticBacktrackNeedsAttentionReason;
  }>;

export type AutomaticBacktrackInput = Readonly<{
  dataRoot: string;
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  sourceDirectory: string;
  result: CodingRunResult;
  effectLedger: EffectLedger;
  runner: CandidateRunner;
  tieCritic?: CandidateTieCritic;
}>;

export async function runAutomaticBacktrack(
  input: AutomaticBacktrackInput,
): Promise<AutomaticBacktrackResult> {
  if (input.result.status === "awaiting_approval") {
    return needsAttention("awaiting-approval");
  }
  if (input.result.pattern === "review") {
    return needsAttention("review-objective");
  }
  if (!isStructuredFailedDelivery(input.result)) {
    return needsAttention("not-a-failed-delivery");
  }
  if (assessAutomaticBacktrackSafety(input.effectLedger).kind !== "safe") {
    return needsAttention("unsafe-effects");
  }
  const policy = automaticBacktrackDecision(input.result);
  if (policy.action !== "compare-two-candidates") {
    return needsAttention("manual-escalation");
  }
  const target = await latestPreMutationTarget(input.checkpoints, input.result.threadId);
  if (target === undefined) return needsAttention("incompatible-replay");
  const request = backtrackRequest(input.result, target);
  const preflight = await preflightBacktrack(request, {
    checkpoints: input.checkpoints,
    sourceDirectory: input.sourceDirectory,
    effectLedger: input.effectLedger,
    snapshotExists: (snapshotId) => input.snapshotStore.has(snapshotId),
  });
  if (preflight.kind !== "accepted") return needsAttention(preflightReason(preflight.kind));

  const root = join(input.dataRoot, "automatic-backtrack");
  const candidateManager = await CandidateWorktreeManager.open(join(root, "candidates"));
  await cleanupExpired(candidateManager, input.checkpoints);
  const promotion = await CandidatePromotion.open(
    join(root, "promotion"),
    candidateManager,
    input.snapshotStore,
  );
  const coordinator = await BacktrackCoordinator.open(join(root, "coordinator"), {
    checkpoints: input.checkpoints,
    snapshotStore: input.snapshotStore,
    candidateManager,
    promotion,
    runner: input.runner,
    ...(input.tieCritic === undefined ? {} : { tieCritic: input.tieCritic }),
  });
  return coordinator.run({
    preflight: {
      kind: "accepted",
      requestId: preflight.requestId,
      threadId: preflight.threadId,
      checkpointId: preflight.checkpointId,
      targetCheckpointSnapshotId: preflight.targetCheckpointSnapshotId,
      sourceSnapshotIdAtAcceptance: preflight.sourceSnapshotIdAtAcceptance,
    },
    sourceDirectory: input.sourceDirectory,
  });
}

export async function cleanupAutomaticBacktrackState(
  dataRoot: string,
  checkpoints: FileCheckpointSaver,
): Promise<void> {
  const manager = await CandidateWorktreeManager.open(
    join(dataRoot, "automatic-backtrack", "candidates"),
  );
  await cleanupExpired(manager, checkpoints);
}

type PreMutationTarget = Readonly<{
  threadId: string;
  checkpointId: string;
  link: SessionCheckpointLinkV1;
}>;

async function latestPreMutationTarget(
  checkpoints: FileCheckpointSaver,
  threadId: string,
): Promise<PreMutationTarget | undefined> {
  for await (const tuple of checkpoints.list({ configurable: { thread_id: threadId } })) {
    let metadata;
    try {
      metadata = checkpointReplayMetadata(tuple.metadata);
    } catch (error) {
      if (error instanceof ReplayCompatibilityError) return undefined;
      throw error;
    }
    if (
      metadata?.replayBinding === undefined ||
      metadata.replayFingerprint === undefined ||
      !metadata.semanticLabels.includes("pre-mutation")
    ) {
      continue;
    }
    const binding = metadata.replayBinding;
    return {
      threadId,
      checkpointId: tuple.checkpoint.id,
      link: {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        entryType: PI_CHECKPOINT_LINK_ENTRY_TYPE,
        threadId,
        checkpointId: tuple.checkpoint.id,
        label: "pre-mutation",
        repositorySnapshot: {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          snapshotId: binding.repositorySnapshot.snapshotId,
          baselineHead: binding.repositorySnapshot.baselineHead,
        },
        replayFingerprint: metadata.replayFingerprint,
        effectLedgerDigest: binding.effectLedgerDigest,
      },
    };
  }
  return undefined;
}

function backtrackRequest(
  result: CodingWorkflowResult,
  target: PreMutationTarget,
): BacktrackRequestV1 {
  const digest = sha256CanonicalJson({
    kind: "automatic-backtrack",
    threadId: result.threadId,
    checkpointId: target.checkpointId,
    iteration: result.iteration,
    verification: result.verification,
  }).slice(0, 48);
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: `automatic-${digest}`,
    sessionId: `runtime-${result.threadId}`,
    entryId: `checkpoint-${digest}`,
    link: target.link,
    candidateIndices: [0, 1],
  };
}

async function cleanupExpired(
  manager: CandidateWorktreeManager,
  checkpoints: FileCheckpointSaver,
): Promise<void> {
  const cleanup = await manager.cleanupExpired();
  for (const ownerId of cleanup.releaseOwnerIds) {
    await checkpoints.deleteThread(ownerId);
  }
}

function preflightReason(
  kind: Exclude<Awaited<ReturnType<typeof preflightBacktrack>>["kind"], "accepted">,
): AutomaticBacktrackNeedsAttentionReason {
  switch (kind) {
    case "incompatible":
    case "blocked_effect":
      return kind === "incompatible" ? "incompatible-replay" : "unsafe-effects";
    case "source_changed":
      return "source-changed";
    case "missing_checkpoint":
      return "missing-checkpoint";
    case "already_terminal":
      return "already-terminal";
    default:
      return assertNever(kind);
  }
}

function needsAttention(
  reason: AutomaticBacktrackNeedsAttentionReason,
): AutomaticBacktrackResult {
  return { kind: "needs_attention", reason };
}

function assertNever(value: never): never {
  throw new AutomaticBacktrackError(value);
}

class AutomaticBacktrackError extends Error {
  readonly name = "AutomaticBacktrackError";

  constructor(readonly value: never) {
    super(`unexpected automatic backtrack state: ${String(value)}`);
  }
}

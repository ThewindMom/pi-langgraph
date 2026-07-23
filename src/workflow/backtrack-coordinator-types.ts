import type { ArtifactRef } from "../evidence/types.ts";
import type {
  CandidateScoreInput,
  CandidateScoreReceipt,
  CandidateTieCriticDecision,
} from "./candidate-scoring.ts";

export const BACKTRACK_CANDIDATE_VARIANTS = ["minimal-change", "alternate-approach"] as const;

export type BacktrackCandidateVariant = typeof BACKTRACK_CANDIDATE_VARIANTS[number];
export type BacktrackCandidateIndex = 0 | 1;
export type CandidateScoreDetails = Omit<CandidateScoreInput, "candidateIndex" | "effects">;

export class BacktrackCoordinatorError extends Error {
  readonly name = "BacktrackCoordinatorError";
}

export type CandidateEvidenceReceipt = Readonly<{
  protocolVersion: 1;
  receiptId: string;
  artifactRefs: readonly ArtifactRef[];
}>;

export type CandidateRunnerReceipt = Readonly<{
  score: CandidateScoreDetails;
  effects: CandidateScoreInput["effects"];
  evidence: CandidateEvidenceReceipt;
}>;

export type CandidateRunner = (
  candidateIndex: BacktrackCandidateIndex,
  threadId: string,
  workspacePath: string,
  variant: BacktrackCandidateVariant,
) => Promise<CandidateRunnerReceipt>;

export type AcceptedBacktrackPreflight = Readonly<{
  kind: "accepted";
  requestId: string;
  threadId: string;
  checkpointId: string;
  targetCheckpointSnapshotId: string;
  sourceSnapshotIdAtAcceptance: string;
}>;

export type CoordinateBacktrackInput = Readonly<{
  preflight: AcceptedBacktrackPreflight;
  sourceDirectory: string;
}>;

export type CoordinatorDurableStage =
  | "candidates-created"
  | "checkpoints-cloned"
  | "candidates-completed"
  | "scored"
  | "promoted"
  | "needs-attention"
  | "cleanup-attempted";

export type CandidateSlot = Readonly<{
  status: "pending" | "running" | "completed" | "failed";
  receipt: CandidateRunnerReceipt | null;
  failure: string | null;
}>;

export type CoordinatorScore = Readonly<{
  winnerCandidateIndex: BacktrackCandidateIndex;
  receipts: readonly [CandidateScoreReceipt, CandidateScoreReceipt];
  tieDecision: CandidateTieCriticDecision | null;
}>;

export type CoordinatorTerminal =
  | Readonly<{ kind: "promoted"; winnerCandidateIndex: BacktrackCandidateIndex; finalSnapshotId: string }>
  | Readonly<{
    kind: "needs_attention";
    reason:
      | "candidate_failed"
      | "candidate_interrupted"
      | "no_eligible_candidate"
      | "tie_critic_failed"
      | "promotion_failed"
      | "promotion_incomplete";
  }>;

export type BacktrackCoordinatorState = Readonly<{
  protocolVersion: 1;
  requestId: string;
  sourceDirectory: string;
  sourceThreadId: string;
  checkpointId: string;
  snapshotId: string;
  candidateThreadIds: readonly [string, string];
  variants: typeof BACKTRACK_CANDIDATE_VARIANTS;
  candidatesCreated: boolean;
  checkpointsCloned: readonly [boolean, boolean];
  candidates: readonly [CandidateSlot, CandidateSlot];
  score: CoordinatorScore | null;
  terminal: CoordinatorTerminal | null;
  cleanupAttempted: boolean;
  cleanupCompleted: boolean;
}>;

export type BacktrackCoordinatorOutcome =
  | Readonly<{
    kind: "promoted";
    requestId: string;
    winnerCandidateIndex: BacktrackCandidateIndex;
    finalSnapshotId: string;
    candidateReceipts: readonly [CandidateRunnerReceipt | null, CandidateRunnerReceipt | null];
    scoreReceipts: readonly [CandidateScoreReceipt, CandidateScoreReceipt];
  }>
  | Readonly<{
    kind: "needs_attention";
    requestId: string;
    reason: Extract<CoordinatorTerminal, { readonly kind: "needs_attention" }>["reason"];
    candidateReceipts: readonly [CandidateRunnerReceipt | null, CandidateRunnerReceipt | null];
    scoreReceipts: readonly [CandidateScoreReceipt, CandidateScoreReceipt] | null;
  }>;

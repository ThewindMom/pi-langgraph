import {
  type BacktrackCandidateIndex,
  BacktrackCoordinatorError,
  type BacktrackCoordinatorOutcome,
  type BacktrackCoordinatorState,
  type CoordinateBacktrackInput,
} from "./backtrack-coordinator-types.ts";
import {
  resolveCandidateScore,
  type CandidateScoreInput,
  type CandidateScoreReceipt,
  type CandidateTieCritic,
} from "./candidate-scoring.ts";

export async function scoreCompletedCandidates(
  state: BacktrackCoordinatorState,
  tieCritic?: CandidateTieCritic,
): Promise<BacktrackCoordinatorState["score"]> {
  const inputs: CandidateScoreInput[] = [];
  for (const index of [0, 1] as const) {
    const receipt = state.candidates[index].receipt;
    if (receipt === null) throw new BacktrackCoordinatorError("candidate receipt is missing");
    inputs.push({ candidateIndex: index, effects: receipt.effects, ...receipt.score });
  }
  try {
    const result = await resolveCandidateScore(inputs, tieCritic);
    return {
      winnerCandidateIndex: result.winner.candidateIndex,
      receipts: receiptPair(result.receipts),
      tieDecision: result.tieDecision,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "no eligible candidate") return null;
    throw error;
  }
}

export function coordinatorOutcome(state: BacktrackCoordinatorState): BacktrackCoordinatorOutcome {
  const terminal = state.terminal;
  if (terminal === null) throw new BacktrackCoordinatorError("terminal outcome is missing");
  const candidateReceipts = [state.candidates[0].receipt, state.candidates[1].receipt] as const;
  if (terminal.kind === "needs_attention") {
    return {
      kind: "needs_attention",
      requestId: state.requestId,
      reason: terminal.reason,
      candidateReceipts,
      scoreReceipts: state.score?.receipts ?? null,
    };
  }
  if (state.score === null) throw new BacktrackCoordinatorError("promoted outcome is missing its score");
  return {
    kind: "promoted",
    requestId: state.requestId,
    winnerCandidateIndex: terminal.winnerCandidateIndex,
    finalSnapshotId: terminal.finalSnapshotId,
    candidateReceipts,
    scoreReceipts: state.score.receipts,
  };
}

export function assertSameRequest(state: BacktrackCoordinatorState, input: CoordinateBacktrackInput): void {
  if (
    state.sourceDirectory !== input.sourceDirectory
    || state.sourceThreadId !== input.preflight.threadId
    || state.checkpointId !== input.preflight.checkpointId
    || state.snapshotId !== input.preflight.sourceSnapshotIdAtAcceptance
  ) throw new BacktrackCoordinatorError("backtrack request conflicts with durable coordinator state");
}

export function otherCandidate(index: BacktrackCandidateIndex): BacktrackCandidateIndex {
  return index === 0 ? 1 : 0;
}

function receiptPair(receipts: readonly CandidateScoreReceipt[]): readonly [CandidateScoreReceipt, CandidateScoreReceipt] {
  const first = receipts.find((receipt) => receipt.candidateIndex === 0);
  const second = receipts.find((receipt) => receipt.candidateIndex === 1);
  if (first === undefined || second === undefined) throw new BacktrackCoordinatorError("score receipts are incomplete");
  return [first, second];
}

export interface CandidateEffects {
  readonly fullyKnown: boolean;
  readonly fullyCompensable: boolean;
}

export interface CandidateHostVerification {
  readonly passed: boolean;
  readonly failedChecks?: number;
}

export interface CandidateScoreInput {
  readonly candidateIndex: 0 | 1;
  readonly replayCompatible: boolean;
  readonly effects: CandidateEffects;
  readonly deliveryCompleted: boolean;
  readonly hostVerification: CandidateHostVerification;
  readonly unresolvedRisks: readonly string[];
  readonly changedPaths: readonly string[];
  readonly changedBytes: number;
  readonly checkFailures?: Readonly<{ readonly test: number; readonly typecheck: number; readonly lint: number; readonly build: number }>;
  readonly unmetAcceptanceCriteria?: number;
  readonly regressions?: number;
  readonly summary?: string;
}

export interface CandidateScoreReceipt {
  readonly candidateIndex: 0 | 1;
  readonly eligible: boolean;
  readonly ineligibilityReasons: readonly string[];
  readonly failedHostChecks: number;
  readonly unresolvedRiskCount: number;
  readonly changedPathCount: number;
  readonly changedByteCount: number;
  readonly changedPaths: readonly string[];
  readonly score: readonly number[];
}

export type CandidateTieCriticInput = Readonly<{
  protocolVersion: 1;
  candidates: readonly [CandidateScoreReceipt, CandidateScoreReceipt];
}>;

export type CandidateTieCriticDecision = Readonly<{
  protocolVersion: 1;
  winnerCandidateIndex: 0 | 1;
}>;

export type CandidateTieCritic = (input: CandidateTieCriticInput) => Promise<unknown>;

export type CandidateScoreResult =
  | Readonly<{
    kind: "selected";
    winner: CandidateScoreReceipt;
    receipts: readonly CandidateScoreReceipt[];
    trueTie: readonly [];
  }>
  | Readonly<{
    kind: "true-tie";
    receipts: readonly CandidateScoreReceipt[];
    trueTie: readonly [0, 1];
  }>;

export type ResolvedCandidateScore = Readonly<{
  readonly winner: CandidateScoreReceipt;
  readonly receipts: readonly CandidateScoreReceipt[];
  readonly tieDecision: CandidateTieCriticDecision | null;
}>;

export class CandidateTieCriticError extends Error {
  readonly name = "CandidateTieCriticError";

  constructor(readonly code: "unavailable" | "invalid-output" | "failed") {
    super(`candidate tie critic ${code}`);
  }
}

export function scoreCandidates(candidates: readonly CandidateScoreInput[]): CandidateScoreResult {
  const receipts = candidates.map(toReceipt).sort((left, right) => left.candidateIndex - right.candidateIndex);
  const eligible = receipts.filter((receipt) => receipt.eligible);
  const winner = eligible.slice().sort(compareReceipts)[0];
  if (winner === undefined) throw new Error("no eligible candidate");
  const tied = eligible.filter((receipt) => sameDimensions(receipt, winner));
  if (tied.length === 2) return { kind: "true-tie", receipts, trueTie: [0, 1] };
  return { kind: "selected", winner, receipts, trueTie: [] };
}

export const selectCandidate = scoreCandidates;

export async function resolveCandidateScore(
  candidates: readonly CandidateScoreInput[],
  critic?: CandidateTieCritic,
): Promise<ResolvedCandidateScore> {
  const scored = scoreCandidates(candidates);
  if (scored.kind === "selected") {
    return { winner: scored.winner, receipts: scored.receipts, tieDecision: null };
  }
  if (critic === undefined) throw new CandidateTieCriticError("unavailable");
  const decision = await resolveTieDecision(critic, receiptPair(scored.receipts));
  const winner = scored.receipts.find((receipt) => receipt.candidateIndex === decision.winnerCandidateIndex);
  if (winner === undefined || !scored.trueTie.includes(winner.candidateIndex)) {
    throw new CandidateTieCriticError("invalid-output");
  }
  return { winner, receipts: scored.receipts, tieDecision: decision };
}

function toReceipt(candidate: CandidateScoreInput): CandidateScoreReceipt {
  const changedPaths = [...new Set(candidate.changedPaths)].sort();
  const failedHostChecks = candidate.hostVerification.failedChecks ?? (candidate.hostVerification.passed ? 0 : 1);
  const checks = candidate.checkFailures ?? { test: 0, typecheck: 0, lint: 0, build: 0 };
  const totalCheckFailures = checks.test + checks.typecheck + checks.lint + checks.build;
  const reasons = [
    ...(candidate.replayCompatible ? [] : ["replay-incompatible"]),
    ...(candidate.effects.fullyKnown ? [] : ["unknown-effects"]),
    ...(candidate.effects.fullyCompensable ? [] : ["noncompensable-effects"]),
    ...(candidate.deliveryCompleted ? [] : ["delivery-incomplete"]),
    ...(candidate.hostVerification.passed ? [] : ["host-verification-failed"]),
  ];
  const eligible = reasons.length === 0;
  return {
    candidateIndex: candidate.candidateIndex,
    eligible,
    ineligibilityReasons: reasons,
    failedHostChecks,
    unresolvedRiskCount: candidate.unresolvedRisks.length,
    changedPathCount: changedPaths.length,
    changedByteCount: candidate.changedBytes,
    changedPaths,
    score: [failedHostChecks, totalCheckFailures, checks.test, checks.typecheck, checks.lint, checks.build, candidate.unmetAcceptanceCriteria ?? 0, candidate.regressions ?? 0, candidate.unresolvedRisks.length, changedPaths.length, candidate.changedBytes],
  };
}

function compareReceipts(left: CandidateScoreReceipt, right: CandidateScoreReceipt): number {
  for (let index = 0; index < left.score.length; index += 1) {
    const difference = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function sameDimensions(left: CandidateScoreReceipt, right: CandidateScoreReceipt): boolean {
  return left.score.every((value, index) => value === right.score[index]);
}

async function resolveTieDecision(
  critic: CandidateTieCritic,
  receipts: readonly [CandidateScoreReceipt, CandidateScoreReceipt],
): Promise<CandidateTieCriticDecision> {
  let output: unknown;
  try {
    output = await critic({ protocolVersion: 1, candidates: receipts });
  } catch (error) {
    if (error instanceof CandidateTieCriticError) throw error;
    throw new CandidateTieCriticError("failed");
  }
  if (!isTieDecision(output)) throw new CandidateTieCriticError("invalid-output");
  return output;
}

function receiptPair(receipts: readonly CandidateScoreReceipt[]): readonly [CandidateScoreReceipt, CandidateScoreReceipt] {
  const first = receipts.find((receipt) => receipt.candidateIndex === 0);
  const second = receipts.find((receipt) => receipt.candidateIndex === 1);
  if (first === undefined || second === undefined) throw new CandidateTieCriticError("invalid-output");
  return [first, second];
}

function isTieDecision(value: unknown): value is CandidateTieCriticDecision {
  if (!isRecord(value)) return false;
  const record = value;
  return Object.keys(record).length === 2
    && record.protocolVersion === 1
    && (record.winnerCandidateIndex === 0 || record.winnerCandidateIndex === 1);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

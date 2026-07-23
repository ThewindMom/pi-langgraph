import type {
  CandidateScoreReceipt,
  CandidateTieCriticDecision,
} from "../workflow/candidate-scoring.ts";
import type {
  CandidatePromotionRecord,
  CandidatePromotionScore,
} from "./candidate-promotion.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export class CandidatePromotionRecordError extends Error {
  readonly name = "CandidatePromotionRecordError";
}

export function parsePromotionRecord(bytes: Uint8Array): CandidatePromotionRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw new CandidatePromotionRecordError("invalid JSON", { cause: error });
    throw error;
  }
  if (
    !isRecord(value)
    || value.protocolVersion !== 1
    || typeof value.requestId !== "string" || !IDENTIFIER.test(value.requestId)
    || typeof value.expectedSnapshotId !== "string" || !DIGEST.test(value.expectedSnapshotId)
    || !(value.winnerCandidateIndex === 0 || value.winnerCandidateIndex === 1)
    || !Array.isArray(value.scoreReceipts) || value.scoreReceipts.length !== 2
    || !isRecord(value.effects)
    || typeof value.effects.fullyKnown !== "boolean"
    || typeof value.effects.fullyCompensable !== "boolean"
    || !(value.tieDecision === undefined || isTieDecision(value.tieDecision))
    || !(value.state === "scored" || value.state === "promoting" || value.state === "promoted")
  ) invalidRecord();
  const scoreReceipts = [
    parseReceipt(value.scoreReceipts[0], 0),
    parseReceipt(value.scoreReceipts[1], 1),
  ] as const;
  const score: CandidatePromotionScore = {
    protocolVersion: 1,
    requestId: value.requestId,
    expectedSnapshotId: value.expectedSnapshotId,
    winnerCandidateIndex: value.winnerCandidateIndex,
    scoreReceipts,
    effects: {
      fullyKnown: value.effects.fullyKnown,
      fullyCompensable: value.effects.fullyCompensable,
    },
    ...(value.tieDecision === undefined ? {} : { tieDecision: value.tieDecision }),
  };
  if (value.state !== "promoted") return { ...score, state: value.state };
  if (typeof value.finalSnapshotId !== "string" || !DIGEST.test(value.finalSnapshotId)) invalidRecord();
  return { ...score, state: "promoted", finalSnapshotId: value.finalSnapshotId };
}

export function validRequestId(requestId: string): boolean {
  return IDENTIFIER.test(requestId);
}

export function samePromotionScore(left: CandidatePromotionScore, right: CandidatePromotionScore): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseReceipt(value: unknown, candidateIndex: 0 | 1): CandidateScoreReceipt {
  if (
    !isRecord(value) || value.candidateIndex !== candidateIndex || typeof value.eligible !== "boolean"
    || !stringArray(value.ineligibilityReasons) || !stringArray(value.changedPaths)
    || !safeNumber(value.failedHostChecks) || !safeNumber(value.unresolvedRiskCount)
    || !safeNumber(value.changedPathCount) || !safeNumber(value.changedByteCount)
    || !numberArray(value.score) || value.changedPathCount !== value.changedPaths.length
    || !sameStrings(value.changedPaths, [...value.changedPaths].sort())
  ) invalidRecord();
  return {
    candidateIndex,
    eligible: value.eligible,
    ineligibilityReasons: value.ineligibilityReasons,
    failedHostChecks: value.failedHostChecks,
    unresolvedRiskCount: value.unresolvedRiskCount,
    changedPathCount: value.changedPathCount,
    changedByteCount: value.changedByteCount,
    changedPaths: value.changedPaths.map(repositoryPath),
    score: value.score,
  };
}

function repositoryPath(path: string): string {
  if (
    path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")
    || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || path === ".git" || path.startsWith(".git/")
  ) invalidRecord();
  return path;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function safeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isTieDecision(value: unknown): value is CandidateTieCriticDecision {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.protocolVersion === 1
    && (value.winnerCandidateIndex === 0 || value.winnerCandidateIndex === 1);
}
function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function numberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every(safeNumber);
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalidRecord(): never {
  throw new CandidatePromotionRecordError("invalid candidate promotion receipt");
}

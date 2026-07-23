import { join, resolve } from "node:path";
import { withFileLock } from "../persistence/file-lock.ts";
import {
  ensurePrivateDirectory,
  readWorkspaceManifest,
  replaceWorkspaceManifest,
} from "../workspace/worktree-manager.ts";
import type {
  BacktrackCoordinatorState,
  CandidateRunnerReceipt,
  CandidateSlot,
  CoordinatorScore,
  CoordinatorTerminal,
} from "./backtrack-coordinator-types.ts";
import type { CandidateScoreReceipt } from "./candidate-scoring.ts";

const MAX_STATE_BYTES = 2 * 1024 * 1024;

export class BacktrackCoordinatorStoreError extends Error {
  readonly name = "BacktrackCoordinatorStoreError";
}

export class BacktrackCoordinatorStore {
  private constructor(
    private readonly recordsRoot: string,
    private readonly locksRoot: string,
  ) {}

  static async open(root: string): Promise<BacktrackCoordinatorStore> {
    const ownedRoot = await ensurePrivateDirectory(resolve(root));
    return new BacktrackCoordinatorStore(
      await ensurePrivateDirectory(join(ownedRoot, "records")),
      await ensurePrivateDirectory(join(ownedRoot, "locks")),
    );
  }

  locked<T>(requestId: string, operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.locksRoot, requestId, operation);
  }

  read(requestId: string): Promise<BacktrackCoordinatorState | undefined> {
    return readWorkspaceManifest(
      this.path(requestId),
      parseCoordinatorState,
      "backtrack coordinator state is not a regular file",
    );
  }

  write(state: BacktrackCoordinatorState): Promise<void> {
    return replaceWorkspaceManifest(this.path(state.requestId), Buffer.from(`${JSON.stringify(state)}\n`));
  }

  private path(requestId: string): string {
    return join(this.recordsRoot, `${requestId}.json`);
  }
}

function parseCoordinatorState(bytes: Uint8Array): BacktrackCoordinatorState {
  if (bytes.byteLength > MAX_STATE_BYTES) throw invalidState();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidState();
    throw error;
  }
  if (!isCoordinatorState(value)) throw invalidState();
  return value;
}

function isCoordinatorState(value: unknown): value is BacktrackCoordinatorState {
  return isRecord(value)
    && value.protocolVersion === 1
    && strings(value, ["requestId", "sourceDirectory", "sourceThreadId", "checkpointId", "snapshotId"])
    && isStringPair(value.candidateThreadIds)
    && Array.isArray(value.variants)
    && value.variants[0] === "minimal-change"
    && value.variants[1] === "alternate-approach"
    && value.variants.length === 2
    && typeof value.candidatesCreated === "boolean"
    && isBooleanPair(value.checkpointsCloned)
    && isSlotPair(value.candidates)
    && (value.score === null || isScore(value.score))
    && (value.terminal === null || isTerminal(value.terminal))
    && typeof value.cleanupAttempted === "boolean"
    && typeof value.cleanupCompleted === "boolean";
}

function isSlotPair(value: unknown): value is readonly [CandidateSlot, CandidateSlot] {
  return Array.isArray(value) && value.length === 2 && value.every(isSlot);
}

function isSlot(value: unknown): value is CandidateSlot {
  return isRecord(value)
    && ["pending", "running", "completed", "failed"].includes(String(value.status))
    && (value.receipt === null || isRunnerReceipt(value.receipt))
    && (value.failure === null || typeof value.failure === "string");
}

function isRunnerReceipt(value: unknown): value is CandidateRunnerReceipt {
  if (!isRecord(value) || !isRecord(value.score) || !isRecord(value.effects) || !isRecord(value.evidence)) return false;
  const score = value.score;
  const effects = value.effects;
  const evidence = value.evidence;
  return typeof score.replayCompatible === "boolean"
    && typeof score.deliveryCompleted === "boolean"
    && isRecord(score.hostVerification)
    && typeof score.hostVerification.passed === "boolean"
    && Array.isArray(score.unresolvedRisks) && score.unresolvedRisks.every(isString)
    && Array.isArray(score.changedPaths) && score.changedPaths.every(isString)
    && typeof score.changedBytes === "number" && Number.isSafeInteger(score.changedBytes) && score.changedBytes >= 0
    && typeof effects.fullyKnown === "boolean"
    && typeof effects.fullyCompensable === "boolean"
    && evidence.protocolVersion === 1
    && typeof evidence.receiptId === "string"
    && Array.isArray(evidence.artifactRefs)
    && evidence.artifactRefs.every(isArtifactRef);
}

function isScore(value: unknown): value is CoordinatorScore {
  return isRecord(value)
    && (value.winnerCandidateIndex === 0 || value.winnerCandidateIndex === 1)
    && isScoreReceiptPair(value.receipts)
    && (value.tieDecision === null || isTieDecision(value.tieDecision));
}

function isScoreReceiptPair(value: unknown): value is readonly [CandidateScoreReceipt, CandidateScoreReceipt] {
  return Array.isArray(value) && value.length === 2 && value.every(isScoreReceipt);
}

function isScoreReceipt(value: unknown): value is CandidateScoreReceipt {
  return isRecord(value)
    && (value.candidateIndex === 0 || value.candidateIndex === 1)
    && typeof value.eligible === "boolean"
    && Array.isArray(value.ineligibilityReasons) && value.ineligibilityReasons.every(isString)
    && numbers(value, ["failedHostChecks", "unresolvedRiskCount", "changedPathCount", "changedByteCount"])
    && Array.isArray(value.changedPaths) && value.changedPaths.every(isString)
    && Array.isArray(value.score) && value.score.every(isNumber);
}

function isTerminal(value: unknown): value is CoordinatorTerminal {
  if (!isRecord(value)) return false;
  if (value.kind === "promoted") {
    return (value.winnerCandidateIndex === 0 || value.winnerCandidateIndex === 1)
      && typeof value.finalSnapshotId === "string";
  }
  return value.kind === "needs_attention"
    && ["candidate_failed", "candidate_interrupted", "no_eligible_candidate", "tie_critic_failed", "promotion_failed", "promotion_incomplete"]
      .includes(String(value.reason));
}

function isTieDecision(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).length === 2
    && value.protocolVersion === 1
    && (value.winnerCandidateIndex === 0 || value.winnerCandidateIndex === 1);
}

function isArtifactRef(value: unknown): boolean {
  return isRecord(value)
    && typeof value.digest === "string"
    && typeof value.byteCount === "number"
    && Number.isSafeInteger(value.byteCount)
    && typeof value.truncated === "boolean";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string { return typeof value === "string"; }
function isNumber(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function isStringPair(value: unknown): value is readonly [string, string] {
  return Array.isArray(value) && value.length === 2 && value.every(isString);
}
function isBooleanPair(value: unknown): value is readonly [boolean, boolean] {
  return Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === "boolean");
}
function strings(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && String(value[key]).length > 0);
}
function numbers(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === "number" && Number.isFinite(value[key]));
}
function invalidState(): BacktrackCoordinatorStoreError {
  return new BacktrackCoordinatorStoreError("invalid backtrack coordinator state");
}

import { canonicalJson, sha256CanonicalJson } from "../bridge/canonical.ts";

const DIGEST = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/;
const MAX_LINEAGE = 256;

type UnknownRecord = Readonly<Record<string, unknown>>;

export type ReplayFingerprintBinding = Readonly<{
  bridgeProtocolVersion: number;
  workflowVersion: number;
  stateVersion: number;
  checkpoint: Readonly<{ threadId: string; checkpointId: string; lineage: readonly string[] }>;
  workflowInput: unknown;
  repositorySnapshot: Readonly<{ snapshotId: string; baselineHead: string | null }>;
  toolModelConfigDigest: string;
  effectLedgerDigest: string;
}>;

export class ReplayCompatibilityError extends Error {
  readonly name = "ReplayCompatibilityError";
}

export function replayFingerprint(input: unknown): string {
  const binding = parseReplayFingerprintBinding(input);
  return sha256CanonicalJson({
    bridgeProtocolVersion: binding.bridgeProtocolVersion,
    workflowVersion: binding.workflowVersion,
    stateVersion: binding.stateVersion,
    checkpoint: binding.checkpoint,
    normalizedWorkflowInput: normalizedWorkflowInput(binding.workflowInput),
    repositorySnapshot: binding.repositorySnapshot,
    toolModelConfigDigest: binding.toolModelConfigDigest,
    effectLedgerDigest: binding.effectLedgerDigest,
  });
}

export function normalizedWorkflowInput(input: unknown): string {
  if (!isJsonValue(input, 0)) fail("workflowInput must be bounded JSON data");
  try {
    return canonicalJson(input);
  } catch (error) {
    if (error instanceof Error) fail("workflowInput cannot be canonically encoded");
    throw error;
  }
}

export function parseReplayFingerprintBinding(input: unknown): ReplayFingerprintBinding {
  const record = requireRecord(input, "replay fingerprint binding");
  exactFields(record, [
    "bridgeProtocolVersion", "workflowVersion", "stateVersion", "checkpoint", "workflowInput",
    "repositorySnapshot", "toolModelConfigDigest", "effectLedgerDigest",
  ]);
  const checkpoint = parseCheckpoint(record.checkpoint);
  const workflowInput = record.workflowInput;
  normalizedWorkflowInput(workflowInput);
  return {
    bridgeProtocolVersion: version(record.bridgeProtocolVersion, "bridgeProtocolVersion"),
    workflowVersion: version(record.workflowVersion, "workflowVersion"),
    stateVersion: version(record.stateVersion, "stateVersion"),
    checkpoint,
    workflowInput,
    repositorySnapshot: parseSnapshot(record.repositorySnapshot),
    toolModelConfigDigest: digest(record.toolModelConfigDigest, "toolModelConfigDigest"),
    effectLedgerDigest: digest(record.effectLedgerDigest, "effectLedgerDigest"),
  };
}

function parseCheckpoint(input: unknown): ReplayFingerprintBinding["checkpoint"] {
  const record = requireRecord(input, "checkpoint");
  exactFields(record, ["threadId", "checkpointId", "lineage"]);
  const checkpointId = identifier(record.checkpointId, "checkpointId");
  if (!Array.isArray(record.lineage) || record.lineage.length === 0 || record.lineage.length > MAX_LINEAGE) {
    fail("checkpoint.lineage must contain 1 to 256 identifiers");
  }
  const lineage = record.lineage.map((entry, index) => identifier(entry, `checkpoint.lineage[${index}]`));
  const terminal = lineage.at(-1);
  if (terminal !== checkpointId) fail("checkpoint lineage must end with checkpointId");
  return { threadId: identifier(record.threadId, "threadId"), checkpointId, lineage };
}

function parseSnapshot(input: unknown): ReplayFingerprintBinding["repositorySnapshot"] {
  const record = requireRecord(input, "repositorySnapshot");
  exactFields(record, ["snapshotId", "baselineHead"]);
  const baselineHead = record.baselineHead;
  if (baselineHead !== null && (typeof baselineHead !== "string" || !GIT_HEAD.test(baselineHead))) {
    fail("repositorySnapshot.baselineHead must be a git head or null");
  }
  return { snapshotId: digest(record.snapshotId, "repositorySnapshot.snapshotId"), baselineHead };
}

function requireRecord(input: unknown, field: string): UnknownRecord {
  if (!isPlainRecord(input)) {
    fail(`${field} must be a plain object`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype;
}

function exactFields(record: UnknownRecord, fields: readonly string[]): void {
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    fail("replay fingerprint binding has unsupported or missing fields");
  }
}

function version(input: unknown, field: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > 10_000) {
    fail(`${field} must be a supported positive integer`);
  }
  return input;
}

function identifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !IDENTIFIER.test(input)) fail(`${field} must be an identifier`);
  return input;
}

function digest(input: unknown, field: string): string {
  if (typeof input !== "string" || !DIGEST.test(input)) fail(`${field} must be a sha256 digest`);
  return input;
}

function isJsonValue(input: unknown, depth: number): boolean {
  if (depth > 32 || input === null || typeof input === "boolean" || typeof input === "string") return depth <= 32;
  if (typeof input === "number") return Number.isFinite(input);
  if (Array.isArray(input)) return input.every((entry) => isJsonValue(entry, depth + 1));
  if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
  return Object.values(input).every((entry) => isJsonValue(entry, depth + 1));
}

function fail(message: string): never {
  throw new ReplayCompatibilityError(message);
}

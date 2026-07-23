import { MAX_CANONICAL_JSON_BYTES } from "./canonical.ts";
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeContractError,
  SEMANTIC_CHECKPOINT_LABELS,
  type CandidateIndex,
  type EffectLedgerDigest,
  type GitHead,
  type LangGraphCheckpointId,
  type LangGraphThreadId,
  type ManagedWorktreeId,
  type ReplayFingerprint,
  type RepositorySnapshotId,
  type SemanticCheckpointLabel,
} from "./types.ts";

const SHA256 = /^[a-f0-9]{64}$/;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/;
const CANDIDATE_WORKTREE_ID = /^candidate-[01]$/;
const ABSOLUTE_PATH = /^\/(?:[^/]+(?:\/|$))*$/;

export type UnknownRecord = Readonly<Record<string, unknown>>;

export function parseEncodedPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (Buffer.byteLength(value, "utf8") > MAX_CANONICAL_JSON_BYTES) fail("invalid-payload", "payload");
  try {
    return JSON.parse(value);
  } catch (error) {
    if (error instanceof SyntaxError) fail("invalid-payload", "payload");
    throw error;
  }
}

export function requireRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) fail("invalid-payload", field);
  return value;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireExactFields(
  record: UnknownRecord,
  allowed: readonly string[],
  optional: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail("unknown-field", `${field}.${key}`);
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in record)) fail("invalid-payload", `${field}.${key}`);
  }
}

export function requireVersion(value: unknown, field: string): void {
  if (value !== BRIDGE_PROTOCOL_VERSION) fail("unsupported-version", field);
}

export function identifier(value: unknown, field: string): LangGraphThreadId & LangGraphCheckpointId {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("invalid-identifier", field);
  return value;
}

export function semanticLabel(value: unknown): SemanticCheckpointLabel {
  if (typeof value === "string") {
    for (const label of SEMANTIC_CHECKPOINT_LABELS) {
      if (value === label) return label;
    }
  }
  fail("invalid-payload", "label");
}

export function digest(value: unknown, field: string): RepositorySnapshotId & ReplayFingerprint & EffectLedgerDigest {
  if (typeof value !== "string" || !SHA256.test(value)) fail("invalid-digest", field);
  return value;
}

export function gitHead(value: unknown, field: string): GitHead | null {
  if (value === null) return null;
  if (typeof value !== "string" || !GIT_HEAD.test(value)) fail("invalid-identifier", field);
  return value;
}

export function candidate(value: unknown): CandidateIndex {
  if (value === 0 || value === 1) return value;
  fail("invalid-candidate-index", "managedWorktree.candidateIndex");
}

export function blockedReason(value: unknown): "incompatible-replay" | "unsafe-effects" | "source-changed" {
  switch (value) {
    case "incompatible-replay":
    case "unsafe-effects":
    case "source-changed":
      return value;
    default:
      fail("invalid-payload", "backtrackOutcome.reason");
  }
}

export function rejectedReason(value: unknown): "invalid-request" | "missing-link" {
  switch (value) {
    case "invalid-request":
    case "missing-link":
      return value;
    default:
      fail("invalid-payload", "backtrackOutcome.reason");
  }
}

export function managedWorktreeId(value: unknown): ManagedWorktreeId {
  if (typeof value !== "string" || !CANDIDATE_WORKTREE_ID.test(value)) {
    fail("invalid-identifier", "managedWorktree.worktreeId");
  }
  return value;
}

export function managedPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !ABSOLUTE_PATH.test(value) ||
    value.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("invalid-path", "managedWorktree.path");
  }
  return value;
}

export function fail(code: ConstructorParameters<typeof BridgeContractError>[0], field: string): never {
  throw new BridgeContractError(code, field);
}

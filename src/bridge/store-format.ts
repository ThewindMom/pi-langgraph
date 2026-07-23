import { canonicalJson } from "./canonical.ts";
import {
  decodeManagedWorktreeRef,
  decodeSessionCheckpointLink,
  sha256CanonicalJson,
} from "./codec.ts";
import type {
  ManagedWorktreeRefV1,
  SessionCheckpointLinkV1,
} from "./types.ts";

export const BRIDGE_INTENT_STORE_VERSION = 1 as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,2047}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export type PreparedIntentKind = "tree" | "fork";
export type PreparedIntentStatus =
  | Readonly<{ kind: "prepared" }>
  | Readonly<{ kind: "consumed"; consumedAtMs: number }>
  | Readonly<{ kind: "expired"; expiredAtMs: number }>;
export type PreparedIntentBinding = Readonly<{
  kind: PreparedIntentKind;
  sessionId: string;
  targetEntryId: string;
  resolvedEntryId: string;
  linkKey: string;
  linkDigest: string;
  link: SessionCheckpointLinkV1;
  managedWorktree: ManagedWorktreeRefV1 | null;
}>;
export type BridgeIntentRecord = Readonly<{
  protocolVersion: 1;
  intentId: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: PreparedIntentStatus;
}> & PreparedIntentBinding;
export type BridgeIntentStoreErrorCode =
  | "corrupt-store"
  | "invalid-intent"
  | "intent-conflict"
  | "intent-mismatch"
  | "missing-intent"
  | "expired-intent";

export class BridgeIntentStoreError extends Error {
  readonly name = "BridgeIntentStoreError";

  constructor(
    readonly code: BridgeIntentStoreErrorCode,
    readonly intentId: string,
  ) {
    super(`bridge intent ${JSON.stringify(intentId)} failed: ${code}`);
  }
}

export function createIntentRecord(
  input: Readonly<{ intentId: string; binding: PreparedIntentBinding; ttlMs: number }>,
  now: number,
): BridgeIntentRecord {
  validateBinding(input.binding, input.intentId);
  if (!IDENTIFIER.test(input.intentId) || !Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new BridgeIntentStoreError("invalid-intent", input.intentId);
  }
  const expiresAtMs = now + input.ttlMs;
  if (!safeIntentTime(expiresAtMs)) throw new BridgeIntentStoreError("invalid-intent", input.intentId);
  return {
    protocolVersion: BRIDGE_INTENT_STORE_VERSION,
    intentId: input.intentId,
    ...input.binding,
    createdAtMs: now,
    expiresAtMs,
    status: { kind: "prepared" },
  };
}

export function parseIntentStore(value: unknown): readonly BridgeIntentRecord[] {
  if (
    !isRecord(value)
    || !exactKeys(value, ["protocolVersion", "intents"])
    || value.protocolVersion !== BRIDGE_INTENT_STORE_VERSION
    || !Array.isArray(value.intents)
  ) corrupt();
  return value.intents.map(parseRecord);
}

export function expireIntents(
  records: readonly BridgeIntentRecord[],
  now: number,
): Readonly<{ records: readonly BridgeIntentRecord[]; changed: boolean }> {
  let changed = false;
  const updated = records.map((record) => {
    if (record.status.kind !== "prepared" || record.expiresAtMs > now) return record;
    changed = true;
    return { ...record, status: { kind: "expired", expiredAtMs: now } } satisfies BridgeIntentRecord;
  });
  return { records: updated, changed };
}

export function sameIntentBinding(record: PreparedIntentBinding, expected: PreparedIntentBinding): boolean {
  return record.kind === expected.kind
    && record.sessionId === expected.sessionId
    && record.targetEntryId === expected.targetEntryId
    && record.resolvedEntryId === expected.resolvedEntryId
    && record.linkKey === expected.linkKey
    && record.linkDigest === expected.linkDigest
    && canonicalJson(record.link) === canonicalJson(expected.link)
    && canonicalJson(record.managedWorktree) === canonicalJson(expected.managedWorktree);
}

export function safeIntentTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRecord(value: unknown): BridgeIntentRecord {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "protocolVersion", "intentId", "kind", "sessionId", "targetEntryId", "resolvedEntryId",
      "linkKey", "linkDigest", "link", "managedWorktree", "createdAtMs", "expiresAtMs", "status",
    ])
    || value.protocolVersion !== BRIDGE_INTENT_STORE_VERSION
    || typeof value.intentId !== "string"
    || !IDENTIFIER.test(value.intentId)
  ) corrupt();
  const binding = parseBinding(value);
  if (!safeIntentTime(value.createdAtMs) || !safeIntentTime(value.expiresAtMs) || value.expiresAtMs < value.createdAtMs) {
    corrupt();
  }
  return {
    protocolVersion: BRIDGE_INTENT_STORE_VERSION,
    intentId: value.intentId,
    ...binding,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    status: parseStatus(value.status),
  };
}

function parseBinding(value: Readonly<Record<string, unknown>>): PreparedIntentBinding {
  const managedWorktree = value.managedWorktree === null ? null : decodeManagedWorktreeRef(value.managedWorktree);
  const link = decodeSessionCheckpointLink(value.link);
  const { kind, sessionId, targetEntryId, resolvedEntryId, linkKey, linkDigest } = value;
  if (
    !(kind === "tree" || kind === "fork")
    || typeof sessionId !== "string"
    || typeof targetEntryId !== "string"
    || typeof resolvedEntryId !== "string"
    || typeof linkKey !== "string"
    || typeof linkDigest !== "string"
  ) corrupt();
  const intentKind: PreparedIntentKind = kind === "tree" ? "tree" : "fork";
  const binding = {
    kind: intentKind,
    sessionId,
    targetEntryId,
    resolvedEntryId,
    linkKey,
    linkDigest,
    link,
    managedWorktree,
  };
  validateBinding(binding, "stored");
  return binding;
}

function parseStatus(value: unknown): PreparedIntentStatus {
  if (!isRecord(value)) corrupt();
  if (value.kind === "prepared" && exactKeys(value, ["kind"])) return { kind: "prepared" };
  if (value.kind === "consumed" && exactKeys(value, ["kind", "consumedAtMs"]) && safeIntentTime(value.consumedAtMs)) {
    return { kind: "consumed", consumedAtMs: value.consumedAtMs };
  }
  if (value.kind === "expired" && exactKeys(value, ["kind", "expiredAtMs"]) && safeIntentTime(value.expiredAtMs)) {
    return { kind: "expired", expiredAtMs: value.expiredAtMs };
  }
  corrupt();
}

function validateBinding(binding: PreparedIntentBinding, intentId: string): void {
  const strings = [binding.sessionId, binding.targetEntryId, binding.resolvedEntryId, binding.linkKey];
  if (strings.some((value) => !IDENTIFIER.test(value)) || !DIGEST.test(binding.linkDigest)) {
    throw new BridgeIntentStoreError("invalid-intent", intentId);
  }
  if (binding.linkDigest !== sha256CanonicalJson(binding.link)) {
    throw new BridgeIntentStoreError("invalid-intent", intentId);
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function corrupt(): never {
  throw new BridgeIntentStoreError("corrupt-store", "prepared-intents-v1.json");
}

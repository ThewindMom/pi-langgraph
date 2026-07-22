import { createHash } from "node:crypto";
import type { SerializedMutationEntry } from "./mutation-journal.ts";

export const FILE_SUFFIX = ".checkpoint.json";
export const FILE_VERSION = 2;
export const MAX_CHECKPOINT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_NAMESPACES = 64;
export const MAX_CHECKPOINTS_PER_NAMESPACE = 256;
export const MAX_TOTAL_CHECKPOINTS = 2_048;
export const MAX_WRITE_BUCKETS = 2_048;
export const MAX_WRITES_PER_BUCKET = 256;
export const MAX_STORAGE_KEY_LENGTH = 2_048;

export interface SerializedCheckpointEntry {
  readonly checkpoint: string;
  readonly metadata: string;
  readonly parentCheckpointId?: string;
}

export interface SerializedWriteEntry {
  readonly key: string;
  readonly taskId: string;
  readonly channel: string;
  readonly value: string;
}

export interface SerializedThread {
  readonly version: typeof FILE_VERSION;
  readonly threadId: string;
  readonly storage: Readonly<Record<string, Readonly<Record<string, SerializedCheckpointEntry>>>>;
  readonly writes: Readonly<Record<string, readonly SerializedWriteEntry[]>>;
  readonly mutations: Readonly<Record<string, SerializedMutationEntry>>;
}

export interface ParsedSerializedThread extends SerializedThread {
  readonly sourceVersion: 1 | typeof FILE_VERSION;
}

export function parseSerializedThread(raw: string, path: string): ParsedSerializedThread {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`invalid checkpoint JSON: ${path}`);
  }
  if (!isRecord(value) || (value.version !== 1 && value.version !== FILE_VERSION) || typeof value.threadId !== "string") {
    throw new Error(`unsupported checkpoint file: ${path}`);
  }
  const fields = value.version === 1
    ? ["version", "threadId", "storage", "writes"]
    : ["version", "threadId", "storage", "writes", "mutations"];
  if (!hasOnlyFields(value, fields)) {
    throw new Error(`unsupported checkpoint fields: ${path}`);
  }
  validateThreadId(value.threadId);
  const storage = parseStorage(value.storage, path);
  const writes = parseWrites(value.writes, path);
  const mutations = value.version === 1 ? Object.create(null) : parseMutations(value.mutations, path);
  return { version: FILE_VERSION, sourceVersion: value.version, threadId: value.threadId, storage, writes, mutations };
}

function parseMutations(value: unknown, path: string): Readonly<Record<string, SerializedMutationEntry>> {
  const result: Record<string, SerializedMutationEntry> = Object.create(null);
  for (const [key, entry] of boundedEntries(value, "mutation journal", 64, path)) {
    if (!/^(implement|repair):(?:0|[1-9]\d*)$/.test(key) || !isRecord(entry)) {
      throw new Error(`invalid mutation journal entry: ${path}`);
    }
    if (entry.status === "started" && hasOnlyFields(entry, ["status"])) {
      result[key] = { status: "started" };
    } else if (
      entry.status === "completed" &&
      hasOnlyFields(entry, ["status", "output"]) &&
      typeof entry.output === "string" &&
      entry.output.length <= MAX_CHECKPOINT_FILE_BYTES
    ) {
      result[key] = { status: "completed", output: entry.output };
    } else {
      throw new Error(`invalid mutation journal entry: ${path}`);
    }
  }
  return result;
}

function parseStorage(
  value: unknown,
  path: string,
): Readonly<Record<string, Readonly<Record<string, SerializedCheckpointEntry>>>> {
  const result: Record<string, Record<string, SerializedCheckpointEntry>> = Object.create(null);
  let totalCheckpoints = 0;
  for (const [namespace, rawCheckpoints] of boundedEntries(
    value,
    "checkpoint storage",
    MAX_NAMESPACES,
    path,
  )) {
    validateStorageKey(namespace, "checkpoint namespace", path);
    const checkpoints: Record<string, SerializedCheckpointEntry> = Object.create(null);
    for (const [checkpointId, rawEntry] of boundedEntries(
      rawCheckpoints,
      "checkpoint namespace",
      MAX_CHECKPOINTS_PER_NAMESPACE,
      path,
    )) {
      totalCheckpoints += 1;
      if (totalCheckpoints > MAX_TOTAL_CHECKPOINTS) throw new Error(`too many checkpoints: ${path}`);
      validateStorageKey(checkpointId, "checkpoint id", path);
      if (
        !isRecord(rawEntry) ||
        !hasOnlyFields(rawEntry, ["checkpoint", "metadata", "parentCheckpointId"]) ||
        typeof rawEntry.checkpoint !== "string" ||
        typeof rawEntry.metadata !== "string" ||
        rawEntry.checkpoint.length > MAX_CHECKPOINT_FILE_BYTES ||
        rawEntry.metadata.length > MAX_CHECKPOINT_FILE_BYTES ||
        (rawEntry.parentCheckpointId !== undefined && typeof rawEntry.parentCheckpointId !== "string")
      ) {
        throw new Error(`invalid checkpoint entry ${JSON.stringify(checkpointId)}: ${path}`);
      }
      if (typeof rawEntry.parentCheckpointId === "string") {
        validateStorageKey(rawEntry.parentCheckpointId, "parent checkpoint id", path);
      }
      checkpoints[checkpointId] = {
        checkpoint: rawEntry.checkpoint,
        metadata: rawEntry.metadata,
        ...(typeof rawEntry.parentCheckpointId === "string"
          ? { parentCheckpointId: rawEntry.parentCheckpointId }
          : {}),
      };
    }
    result[namespace] = checkpoints;
  }
  return result;
}

function parseWrites(value: unknown, path: string): Readonly<Record<string, readonly SerializedWriteEntry[]>> {
  const result: Record<string, SerializedWriteEntry[]> = Object.create(null);
  for (const [outerKey, rawEntries] of boundedEntries(value, "checkpoint writes", MAX_WRITE_BUCKETS, path)) {
    if (outerKey.length > MAX_STORAGE_KEY_LENGTH) throw new Error(`checkpoint write key is too long: ${path}`);
    if (!Array.isArray(rawEntries)) throw new Error(`invalid checkpoint write list: ${path}`);
    if (rawEntries.length > MAX_WRITES_PER_BUCKET) throw new Error(`too many checkpoint writes: ${path}`);
    result[outerKey] = rawEntries.map((rawEntry) => {
      if (
        !isRecord(rawEntry) ||
        !hasOnlyFields(rawEntry, ["key", "taskId", "channel", "value"]) ||
        typeof rawEntry.key !== "string" ||
        typeof rawEntry.taskId !== "string" ||
        typeof rawEntry.channel !== "string" ||
        typeof rawEntry.value !== "string" ||
        rawEntry.key.length > MAX_STORAGE_KEY_LENGTH ||
        rawEntry.taskId.length > MAX_STORAGE_KEY_LENGTH ||
        rawEntry.channel.length > MAX_STORAGE_KEY_LENGTH ||
        rawEntry.value.length > MAX_CHECKPOINT_FILE_BYTES
      ) {
        throw new Error(`invalid checkpoint write entry: ${path}`);
      }
      return { key: rawEntry.key, taskId: rawEntry.taskId, channel: rawEntry.channel, value: rawEntry.value };
    });
  }
  return result;
}

export function validateThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId)) {
    throw new Error("thread_id must be a 1-128 character lexical identifier");
  }
}

export function fileNameForThread(threadId: string): string {
  return `${createHash("sha256").update(threadId).digest("hex")}${FILE_SUFFIX}`;
}

export interface WriteBucketKey {
  readonly threadId: string;
  readonly namespace: string;
  readonly checkpointId: string;
}

export function parseWriteBucketKey(key: string): WriteBucketKey {
  let value: unknown;
  try {
    value = JSON.parse(key);
  } catch {
    throw new Error("invalid checkpoint write key");
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== "string" ||
    typeof value[1] !== "string" ||
    typeof value[2] !== "string" ||
    value.some((part) => part.length > MAX_STORAGE_KEY_LENGTH)
  ) {
    throw new Error("invalid checkpoint write key");
  }
  return { threadId: value[0], namespace: value[1], checkpointId: value[2] };
}

export function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

export function decode(value: string): Uint8Array {
  if (value.length > MAX_CHECKPOINT_FILE_BYTES) throw new Error("checkpoint base64 payload is too large");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("invalid checkpoint base64 payload");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new Error("non-canonical checkpoint base64 payload");
  return new Uint8Array(decoded);
}

export function boundedEntries(value: unknown, field: string, maxEntries: number, path: string): Array<[string, unknown]> {
  if (!isRecord(value)) throw new Error(`invalid ${field}: ${path}`);
  const entries = Object.entries(value);
  if (entries.length > maxEntries) throw new Error(`${field} exceeds ${maxEntries} entries: ${path}`);
  return entries;
}

export function validateStorageKey(value: string, field: string, path: string): void {
  if (value.length > MAX_STORAGE_KEY_LENGTH) throw new Error(`${field} is too long: ${path}`);
}

export function hasOnlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  const allowed = new Set(fields);
  return Object.keys(value).every((field) => allowed.has(field));
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

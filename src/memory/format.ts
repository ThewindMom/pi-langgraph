import type { ArtifactRef } from "../evidence/types.ts";

export const MEMORY_FILE_VERSION = 1;
export const MAX_MEMORY_FILE_BYTES = 1 * 1024 * 1024;
export const MAX_MEMORY_ENTRIES = 4096;

export type MemoryProvenance = Readonly<{
  readonly sourceCheckpointId: string;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly observedAt: string;
  readonly schemaVersion: number;
  readonly confidence: number;
}>;

export type MemoryEnvelope = Readonly<{
  readonly version: typeof MEMORY_FILE_VERSION;
  readonly entries: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}>;

export function serializeMemory(envelope: MemoryEnvelope): string {
  const raw = JSON.stringify(envelope);
  if (raw === undefined || new TextEncoder().encode(raw).byteLength > MAX_MEMORY_FILE_BYTES) {
    throw new Error("repository memory exceeds size limit");
  }
  return raw;
}

export function parseMemory(raw: string, path: string): MemoryEnvelope {
  if (new TextEncoder().encode(raw).byteLength > MAX_MEMORY_FILE_BYTES) throw new Error(`repository memory exceeds size limit: ${path}`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`invalid repository memory JSON: ${path}`); }
  if (!isRecord(parsed) || parsed.version !== MEMORY_FILE_VERSION || !isRecord(parsed.entries)) throw new Error(`invalid repository memory file: ${path}`);
  const entries: Record<string, Record<string, unknown>> = Object.create(null);
  let count = 0;
  for (const [snapshot, rawFacts] of Object.entries(parsed.entries)) {
    validateSnapshotId(snapshot);
    if (!isRecord(rawFacts)) throw new Error(`invalid repository memory entries: ${path}`);
    const facts: Record<string, unknown> = Object.create(null);
    for (const [key, fact] of Object.entries(rawFacts)) {
      validateMemoryKey(key);
      if (fact === undefined) throw new Error(`invalid repository memory fact: ${path}`);
      count += 1;
      if (count > MAX_MEMORY_ENTRIES) throw new Error(`too many repository memory facts: ${path}`);
      facts[key] = fact;
    }
    entries[snapshot] = facts;
  }
  return { version: MEMORY_FILE_VERSION, entries };
}

export function validateSnapshotId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid repository snapshot id");
}

export function validateMemoryKey(value: string): void {
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value) || value.includes("/") || value.includes("\\")) {
    throw new Error("invalid repository memory key");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

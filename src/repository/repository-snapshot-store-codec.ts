import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { SNAPSHOT_PROTOCOL_VERSION } from "./snapshot.ts";
import {
  RepositorySnapshotStoreError,
  type StoredRepositorySnapshot,
} from "./repository-snapshot-store-types.ts";

export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const HEAD_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export type SnapshotEntry = Readonly<{
  path: string;
  blobId: string;
  executable: boolean;
  size: number;
}>;

export type SnapshotManifest = StoredRepositorySnapshot & Readonly<{
  entries: readonly SnapshotEntry[];
  deletedPaths: readonly string[];
}>;

type ManifestEnvelope = Readonly<{ manifest: SnapshotManifest; digest: string }>;

export function parseEnvelope(raw: Buffer, expectedId: string): ManifestEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new RepositorySnapshotStoreError("corrupt-snapshot", "invalid repository snapshot manifest JSON", error);
  }
  if (!isRecord(value) || !onlyFields(value, ["manifest", "digest"]) || typeof value.digest !== "string") {
    throw new RepositorySnapshotStoreError("corrupt-snapshot", "invalid repository snapshot envelope");
  }
  const manifest = parseManifest(value.manifest, expectedId);
  if (digest(Buffer.from(JSON.stringify(manifest))) !== value.digest) {
    throw new RepositorySnapshotStoreError("corrupt-snapshot", "repository snapshot manifest digest mismatch");
  }
  return { manifest, digest: value.digest };
}

export function repositoryPath(path: string): string {
  const segments = path.split("/");
  if (
    path.length === 0
    || isAbsolute(path)
    || path.includes("\\")
    || path.includes("\0")
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || segments[0] === ".git"
  ) throw new RepositorySnapshotStoreError("unsafe-entry", `unsafe repository snapshot path: ${JSON.stringify(path)}`);
  return path;
}

export function digest(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sameEntries(left: readonly SnapshotEntry[], right: readonly SnapshotEntry[]): boolean {
  return left.length === right.length && left.every((entry, index) => {
    const candidate = right[index];
    return candidate !== undefined
      && entry.path === candidate.path
      && entry.blobId === candidate.blobId
      && entry.executable === candidate.executable
      && entry.size === candidate.size;
  });
}

function parseManifest(value: unknown, expectedId: string): SnapshotManifest {
  if (!isRecord(value) || !onlyFields(value, ["protocolVersion", "snapshotId", "baselineHead", "dirty", "entries", "deletedPaths"])) {
    throw new RepositorySnapshotStoreError("corrupt-snapshot", "invalid repository snapshot manifest");
  }
  if (
    value.protocolVersion !== SNAPSHOT_PROTOCOL_VERSION
    || value.snapshotId !== expectedId
    || typeof value.dirty !== "boolean"
    || !(value.baselineHead === null || (typeof value.baselineHead === "string" && HEAD_PATTERN.test(value.baselineHead)))
    || !Array.isArray(value.entries)
    || !Array.isArray(value.deletedPaths)
  ) throw new RepositorySnapshotStoreError("corrupt-snapshot", "invalid repository snapshot manifest fields");
  const entries = value.entries.map(parseEntry);
  const deletedPaths = value.deletedPaths.map(repositoryPathValue);
  if (!orderedUnique(entries.map((entry) => entry.path)) || !orderedUnique(deletedPaths)) {
    throw new RepositorySnapshotStoreError("corrupt-snapshot", "repository snapshot paths are not canonical");
  }
  return {
    protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
    snapshotId: expectedId,
    baselineHead: value.baselineHead,
    dirty: value.dirty,
    entries,
    deletedPaths,
  };
}

function parseEntry(value: unknown): SnapshotEntry {
  if (
    !isRecord(value)
    || !onlyFields(value, ["path", "blobId", "executable", "size"])
    || typeof value.blobId !== "string"
    || !DIGEST_PATTERN.test(value.blobId)
    || typeof value.executable !== "boolean"
    || typeof value.size !== "number"
    || !Number.isSafeInteger(value.size)
    || value.size < 0
  ) throw new RepositorySnapshotStoreError("corrupt-snapshot", "invalid repository snapshot entry");
  return { path: repositoryPathValue(value.path), blobId: value.blobId, executable: value.executable, size: value.size };
}

function repositoryPathValue(value: unknown): string {
  if (typeof value !== "string") throw new RepositorySnapshotStoreError("corrupt-snapshot", "snapshot path must be a string");
  return repositoryPath(value);
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return index === 0 || previous !== undefined && previous < value;
  });
}

function onlyFields(value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean {
  const expected = new Set(fields);
  return Object.keys(value).length === expected.size && Object.keys(value).every((field) => expected.has(field));
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

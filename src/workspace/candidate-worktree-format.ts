import { isAbsolute, join } from "node:path";
import type { RepositorySnapshotStore, StoredRepositorySnapshot } from "../repository/repository-snapshot-store.ts";
import { WorktreeManagerError } from "./format.ts";

export type CandidateIndex = 0 | 1;
export type CandidateLifecycleStatus =
  | Readonly<{ protocolVersion: 1; kind: "active" | "completed" | "loser" | "abandoned" | "cleanup_failed" }>
  | Readonly<{ protocolVersion: 1; kind: "winner"; finalized: boolean }>;
export type CandidateLease = Readonly<{ protocolVersion: 1; expiresAtMs: number }>;
export type CandidateWorktree = Readonly<{
  protocolVersion: 1;
  candidateIndex: CandidateIndex;
  workspacePath: string;
  registration: "linked-worktree" | "unborn-repository";
  status: CandidateLifecycleStatus;
  pinned: boolean;
  lease: CandidateLease;
  removedAtMs: number | null;
}>;
export type CandidatePairManifest = Readonly<{
  protocolVersion: 1;
  requestId: string;
  snapshotId: string;
  sourceRepositoryRoot: string;
  baselineHead: string | null;
  sourceThreadId: string;
  checkpointId: string;
  retentionOwnerIds: readonly [string, string];
  createdAtMs: number;
  candidates: readonly [CandidateWorktree, CandidateWorktree];
}>;
export type CandidateManagerOptions = Readonly<{ clock: () => number; ttlMs: number }>;
export type CreateCandidatePairInput = Readonly<{
  requestId: string;
  sourceCwd: string;
  sourceThreadId: string;
  checkpointId: string;
  retentionOwnerIds: readonly [string, string];
  snapshot: StoredRepositorySnapshot;
  snapshotStore: RepositorySnapshotStore;
}>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SNAPSHOT_ID = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

export function serializeCandidateManifest(manifest: CandidatePairManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
}

export function createCandidateManifest(input: Readonly<{
  requestId: string;
  snapshotId: string;
  sourceRepositoryRoot: string;
  baselineHead: string | null;
  sourceThreadId: string;
  checkpointId: string;
  retentionOwnerIds: readonly [string, string];
  createdAtMs: number;
  expiresAtMs: number;
  worktreesRoot: string;
}>): CandidatePairManifest {
  const registration = input.baselineHead === null ? "unborn-repository" : "linked-worktree";
  const candidate = (candidateIndex: CandidateIndex): CandidateWorktree => Object.freeze({
    protocolVersion: 1,
    candidateIndex,
    workspacePath: join(input.worktreesRoot, `${input.requestId}-${candidateIndex}`),
    registration,
    status: Object.freeze({ protocolVersion: 1, kind: "active" }),
    pinned: true,
    lease: Object.freeze({ protocolVersion: 1, expiresAtMs: input.expiresAtMs }),
    removedAtMs: null,
  });
  return Object.freeze({
    protocolVersion: 1,
    requestId: input.requestId,
    snapshotId: input.snapshotId,
    sourceRepositoryRoot: input.sourceRepositoryRoot,
    baselineHead: input.baselineHead,
    sourceThreadId: input.sourceThreadId,
    checkpointId: input.checkpointId,
    retentionOwnerIds: Object.freeze(input.retentionOwnerIds),
    createdAtMs: input.createdAtMs,
    candidates: Object.freeze([candidate(0), candidate(1)] as const),
  });
}

export function parseCandidateManifest(bytes: Uint8Array): CandidatePairManifest {
  const value = parseJson(bytes);
  if (
    !isRecord(value)
    || value.protocolVersion !== 1
    || typeof value.requestId !== "string"
    || !IDENTIFIER.test(value.requestId)
    || typeof value.snapshotId !== "string"
    || !SNAPSHOT_ID.test(value.snapshotId)
    || typeof value.sourceRepositoryRoot !== "string"
    || !isAbsolute(value.sourceRepositoryRoot)
    || !(value.baselineHead === null || typeof value.baselineHead === "string" && OBJECT_ID.test(value.baselineHead))
    || typeof value.sourceThreadId !== "string"
    || !IDENTIFIER.test(value.sourceThreadId)
    || typeof value.checkpointId !== "string"
    || !IDENTIFIER.test(value.checkpointId)
    || !Array.isArray(value.retentionOwnerIds)
    || value.retentionOwnerIds.length !== 2
    || value.retentionOwnerIds.some((owner) => typeof owner !== "string" || !IDENTIFIER.test(owner))
    || value.retentionOwnerIds[0] === value.retentionOwnerIds[1]
    || typeof value.createdAtMs !== "number"
    || !safeTime(value.createdAtMs)
    || !Array.isArray(value.candidates)
    || value.candidates.length !== 2
  ) invalidManifest();
  return Object.freeze({
    protocolVersion: 1,
    requestId: value.requestId,
    snapshotId: value.snapshotId,
    sourceRepositoryRoot: value.sourceRepositoryRoot,
    baselineHead: value.baselineHead,
    sourceThreadId: value.sourceThreadId,
    checkpointId: value.checkpointId,
    retentionOwnerIds: Object.freeze([value.retentionOwnerIds[0], value.retentionOwnerIds[1]] as const),
    createdAtMs: value.createdAtMs,
    candidates: Object.freeze([
      parseCandidate(value.candidates[0], 0),
      parseCandidate(value.candidates[1], 1),
    ] as const),
  });
}

function parseCandidate(value: unknown, candidateIndex: CandidateIndex): CandidateWorktree {
  if (
    !isRecord(value)
    || value.protocolVersion !== 1
    || value.candidateIndex !== candidateIndex
    || typeof value.workspacePath !== "string"
    || !isAbsolute(value.workspacePath)
    || !(value.registration === "linked-worktree" || value.registration === "unborn-repository")
    || typeof value.pinned !== "boolean"
    || !isRecord(value.lease)
    || value.lease.protocolVersion !== 1
    || typeof value.lease.expiresAtMs !== "number"
    || !safeTime(value.lease.expiresAtMs)
    || !(value.removedAtMs === null || typeof value.removedAtMs === "number" && safeTime(value.removedAtMs))
  ) invalidManifest();
  return Object.freeze({
    protocolVersion: 1,
    candidateIndex,
    workspacePath: value.workspacePath,
    registration: value.registration,
    status: parseStatus(value.status),
    pinned: value.pinned,
    lease: Object.freeze({ protocolVersion: 1, expiresAtMs: value.lease.expiresAtMs }),
    removedAtMs: value.removedAtMs,
  });
}

function parseStatus(value: unknown): CandidateLifecycleStatus {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.kind !== "string") invalidManifest();
  if (value.kind === "winner") {
    if (typeof value.finalized !== "boolean") invalidManifest();
    return Object.freeze({ protocolVersion: 1, kind: "winner", finalized: value.finalized });
  }
  if (
    value.kind !== "active"
    && value.kind !== "completed"
    && value.kind !== "loser"
    && value.kind !== "abandoned"
    && value.kind !== "cleanup_failed"
  ) invalidManifest();
  return Object.freeze({ protocolVersion: 1, kind: value.kind });
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) invalidManifest();
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) invalidManifest();
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeTime(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function invalidManifest(): never {
  throw new WorktreeManagerError("invalid_manifest", "invalid candidate worktree manifest");
}

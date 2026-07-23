import { chmod, mkdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "../persistence/file-lock.ts";
import { getRepositoryRoot } from "../repository/git.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import { createRepositorySnapshot } from "../repository/snapshot.ts";
import {
  type CleanupResult,
  cleanupExpiredCandidates,
  isCandidateRegistered,
} from "./candidate-worktree-cleanup.ts";
import {
  type CandidateIndex,
  type CandidateLifecycleStatus,
  type CandidateManagerOptions,
  type CandidatePairManifest,
  type CandidateWorktree,
  createCandidateManifest,
  parseCandidateManifest,
  serializeCandidateManifest,
  type CreateCandidatePairInput,
} from "./candidate-worktree-format.ts";
import { validateLexicalId, WorktreeManagerError } from "./format.ts";
import {
  ensurePrivateDirectory,
  gitOutput,
  pathExists,
  readWorkspaceManifest,
  replaceWorkspaceManifest,
} from "./worktree-manager.ts";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const MANAGER_LOCK = "candidate-manager";

export class CandidateWorktreeManager {
  private constructor(
    private readonly manifestsRoot: string,
    private readonly worktreesRoot: string,
    private readonly options: CandidateManagerOptions,
  ) {}

  static async open(root: string, options?: Partial<CandidateManagerOptions>): Promise<CandidateWorktreeManager> {
    const now = options?.clock ?? Date.now;
    const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new WorktreeManagerError("invalid_input", "candidate lease TTL must be a positive safe integer");
    }
    const managerRoot = await ensurePrivateDirectory(resolve(root));
    return new CandidateWorktreeManager(
      await ensurePrivateDirectory(join(managerRoot, "manifests")),
      await ensurePrivateDirectory(join(managerRoot, "worktrees")),
      { clock: now, ttlMs },
    );
  }

  async createPair(input: CreateCandidatePairInput): Promise<CandidatePairManifest> {
    validateLexicalId(input.requestId, "candidate request ID");
    validateLexicalId(input.sourceThreadId, "source thread ID");
    validateLexicalId(input.checkpointId, "checkpoint ID");
    for (const ownerId of input.retentionOwnerIds) validateLexicalId(ownerId, "retention owner ID");
    if (input.retentionOwnerIds.length !== 2 || input.retentionOwnerIds[0] === input.retentionOwnerIds[1]) {
      throw new WorktreeManagerError("invalid_input", "candidate retention owner IDs must be distinct");
    }
    return this.locked(() => this.createPairLocked(input));
  }

  private async createPairLocked(input: CreateCandidatePairInput): Promise<CandidatePairManifest> {
    const sourceRepositoryRoot = await realpath(await getRepositoryRoot(input.sourceCwd));
    const current = await createRepositorySnapshot(sourceRepositoryRoot);
    if (
      current.snapshotId !== input.snapshot.snapshotId
      || current.head !== input.snapshot.baselineHead
      || current.dirty !== input.snapshot.dirty
    ) throw new WorktreeManagerError("candidate_conflict", "source no longer matches the captured repository snapshot");
    const manifestPath = this.manifestPath(input.requestId);
    const existing = await readWorkspaceManifest(manifestPath, parseCandidateManifest, "candidate manifest is not a regular file");
    if (existing !== undefined) {
      if (await this.matches(existing, input, sourceRepositoryRoot)) return existing;
      throw new WorktreeManagerError("candidate_conflict", `candidate request already exists: ${input.requestId}`);
    }
    const createdAtMs = this.now();
    const pair = createCandidateManifest({
      requestId: input.requestId,
      snapshotId: input.snapshot.snapshotId,
      sourceRepositoryRoot,
      baselineHead: input.snapshot.baselineHead,
      sourceThreadId: input.sourceThreadId,
      checkpointId: input.checkpointId,
      retentionOwnerIds: input.retentionOwnerIds,
      createdAtMs,
      expiresAtMs: createdAtMs + this.options.ttlMs,
      worktreesRoot: this.worktreesRoot,
    });
    for (const candidate of pair.candidates) {
      if (await pathExists(candidate.workspacePath)) {
        throw new WorktreeManagerError("candidate_conflict", `candidate path already exists: ${candidate.workspacePath}`);
      }
    }
    try {
      for (const candidate of pair.candidates) await this.createCandidate(pair, candidate, input.snapshotStore);
      await replaceWorkspaceManifest(manifestPath, serializeCandidateManifest(pair));
      return pair;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await this.rollback(pair);
      throw error;
    }
  }

  async getPair(requestId: string): Promise<CandidatePairManifest | undefined> {
    validateLexicalId(requestId, "candidate request ID");
    return readWorkspaceManifest(this.manifestPath(requestId), parseCandidateManifest, "candidate manifest is not a regular file");
  }

  async getPairForPromotion(requestId: string, candidateIndex: CandidateIndex): Promise<CandidatePairManifest> {
    const pair = await this.requiredPair(requestId);
    const candidate = pair.candidates[candidateIndex];
    const expectedPath = join(this.worktreesRoot, `${requestId}-${candidateIndex}`);
    if (
      candidate.workspacePath !== expectedPath
      || candidate.removedAtMs !== null
      || await realpath(candidate.workspacePath) !== expectedPath
      || !isCandidateRegistered(pair.sourceRepositoryRoot, candidate)
    ) {
      throw new WorktreeManagerError("candidate_conflict", "candidate is not a registered manager-owned worktree");
    }
    return pair;
  }

  async setStatus(requestId: string, candidateIndex: CandidateIndex, status: CandidateLifecycleStatus): Promise<void> {
    return this.locked(async () => {
      const pair = await this.requiredPair(requestId);
      await this.replaced(pair, candidateIndex, { ...pair.candidates[candidateIndex], status: Object.freeze(status) });
    });
  }

  async setPinned(requestId: string, candidateIndex: CandidateIndex, pinned: boolean): Promise<void> {
    return this.locked(async () => {
      const pair = await this.requiredPair(requestId);
      await this.replaced(pair, candidateIndex, { ...pair.candidates[candidateIndex], pinned });
    });
  }

  async renewLease(requestId: string, candidateIndex: CandidateIndex): Promise<void> {
    return this.locked(async () => {
      const pair = await this.requiredPair(requestId);
      const candidate = pair.candidates[candidateIndex];
      await this.replaced(pair, candidateIndex, {
        ...candidate,
        lease: Object.freeze({ protocolVersion: 1, expiresAtMs: this.now() + this.options.ttlMs }),
      });
    });
  }

  async cleanupExpired(): Promise<CleanupResult> {
    return this.locked(() => cleanupExpiredCandidates({
      manifestsRoot: this.manifestsRoot,
      worktreesRoot: this.worktreesRoot,
      now: () => this.now(),
      requiredPair: (requestId) => this.requiredPair(requestId),
      replaceCandidate: (pair, candidateIndex, candidate) => this.replaced(pair, candidateIndex, candidate),
    }));
  }

  private async createCandidate(
    pair: CandidatePairManifest,
    candidate: CandidateWorktree,
    store: RepositorySnapshotStore,
  ): Promise<void> {
    if (pair.baselineHead === null) {
      await mkdir(candidate.workspacePath, { mode: 0o700 });
      await store.materialize(pair.snapshotId, {
        kind: "empty-directory",
        managerRoot: this.worktreesRoot,
        destination: candidate.workspacePath,
      });
      gitOutput(candidate.workspacePath, ["init"], "unable to initialize unborn candidate");
      return;
    }
    gitOutput(pair.sourceRepositoryRoot, ["worktree", "add", "--detach", candidate.workspacePath, pair.baselineHead], "unable to create candidate worktree");
    await chmod(candidate.workspacePath, 0o700);
    await store.materialize(pair.snapshotId, {
      kind: "managed-worktree",
      managerRoot: this.worktreesRoot,
      destination: candidate.workspacePath,
    });
  }

  private async rollback(pair: CandidatePairManifest): Promise<void> {
    for (const candidate of [...pair.candidates].reverse()) {
      if (!await pathExists(candidate.workspacePath)) continue;
      if (candidate.registration === "linked-worktree") {
        gitOutput(pair.sourceRepositoryRoot, ["worktree", "remove", "--force", candidate.workspacePath], "unable to roll back candidate worktree");
      } else {
        await rm(candidate.workspacePath, { recursive: true });
      }
    }
  }

  private async matches(pair: CandidatePairManifest, input: CreateCandidatePairInput, sourceRoot: string): Promise<boolean> {
    if (!(
      pair.snapshotId === input.snapshot.snapshotId
      && pair.baselineHead === input.snapshot.baselineHead
      && pair.sourceRepositoryRoot === sourceRoot
      && pair.sourceThreadId === input.sourceThreadId
      && pair.checkpointId === input.checkpointId
      && pair.retentionOwnerIds.every((ownerId, index) => ownerId === input.retentionOwnerIds[index])
    )) return false;
    for (const candidate of pair.candidates) {
      if (
        candidate.workspacePath !== join(this.worktreesRoot, `${pair.requestId}-${candidate.candidateIndex}`)
        || candidate.removedAtMs !== null
        || !await pathExists(candidate.workspacePath)
        || !isCandidateRegistered(pair.sourceRepositoryRoot, candidate)
      ) return false;
    }
    return true;
  }

  private async requiredPair(requestId: string): Promise<CandidatePairManifest> {
    validateLexicalId(requestId, "candidate request ID");
    const pair = await readWorkspaceManifest(this.manifestPath(requestId), parseCandidateManifest, "candidate manifest is not a regular file");
    if (pair === undefined) throw new WorktreeManagerError("invalid_manifest", `candidate request does not exist: ${requestId}`);
    return pair;
  }

  private async replaced(
    pair: CandidatePairManifest,
    candidateIndex: CandidateIndex,
    candidate: CandidateWorktree,
  ): Promise<CandidatePairManifest> {
    const candidates = candidateIndex === 0
      ? Object.freeze([candidate, pair.candidates[1]] as const)
      : Object.freeze([pair.candidates[0], candidate] as const);
    const updated = Object.freeze({ ...pair, candidates });
    await replaceWorkspaceManifest(this.manifestPath(pair.requestId), serializeCandidateManifest(updated));
    return updated;
  }

  private manifestPath(requestId: string): string {
    return join(this.manifestsRoot, `${requestId}.json`);
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.manifestsRoot, MANAGER_LOCK, operation);
  }

  private now(): number {
    const value = this.options.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new WorktreeManagerError("invalid_input", "clock returned an invalid timestamp");
    return value;
  }
}

export type {
  CandidateIndex,
  CandidateLease,
  CandidateLifecycleStatus,
  CandidateManagerOptions,
  CandidatePairManifest,
  CandidateWorktree,
  CreateCandidatePairInput,
} from "./candidate-worktree-format.ts";
export type { CleanupDiagnostic, CleanupDiagnosticKind, CleanupResult } from "./candidate-worktree-cleanup.ts";
export { WorktreeManagerError } from "./format.ts";

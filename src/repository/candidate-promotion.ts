import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { withFileLock } from "../persistence/file-lock.ts";
import type { CandidateScoreReceipt, CandidateTieCriticDecision } from "../workflow/candidate-scoring.ts";
import type { CandidateWorktreeManager } from "../workspace/candidate-worktree-manager.ts";
import { ensurePrivateDirectory, readWorkspaceManifest, replaceWorkspaceManifest } from "../workspace/worktree-manager.ts";
import { applyDelta, CandidatePromotionFileError, repositoryDelta } from "./candidate-promotion-files.ts";
import {
  CandidatePromotionRecordError,
  parsePromotionRecord,
  samePromotionScore,
  validRequestId,
} from "./candidate-promotion-record.ts";
import { getRepositoryHead, getRepositoryRoot } from "./git.ts";
import {
  RepositorySnapshotStoreError,
  type RepositorySnapshotStore,
} from "./repository-snapshot-store.ts";
import {
  SourceTreeTransaction,
  SourceTreeTransactionError,
} from "./source-tree-transaction.ts";

export type CandidatePromotionScore = Readonly<{
  protocolVersion: 1;
  requestId: string;
  expectedSnapshotId: string;
  winnerCandidateIndex: 0 | 1;
  scoreReceipts: readonly [CandidateScoreReceipt, CandidateScoreReceipt];
  effects: Readonly<{ fullyKnown: boolean; fullyCompensable: boolean }>;
  tieDecision?: CandidateTieCriticDecision;
}>;
export type CandidatePromotionRecord = CandidatePromotionScore & (
  | Readonly<{ state: "scored" | "promoting" }>
  | Readonly<{ state: "promoted"; finalSnapshotId: string }>
);
export type CandidatePromotionOptions = Readonly<{
  beforePublishPath?: (path: string, index: number) => Promise<void>;
}>;
export type CandidatePromotionErrorCode =
  | "already_promoted"
  | "invalid_receipt"
  | "publish_failed"
  | "source_changed"
  | "unsafe_candidate"
  | "unsafe_effects";

export class CandidatePromotionError extends Error {
  readonly name = "CandidatePromotionError";
  constructor(readonly code: CandidatePromotionErrorCode, cause?: unknown) {
    super(`candidate promotion failed: ${code}`, cause === undefined ? undefined : { cause });
  }
}

export class CandidatePromotion {
  private constructor(
    private readonly recordsRoot: string,
    private readonly locksRoot: string,
    private readonly manager: CandidateWorktreeManager,
    private readonly store: RepositorySnapshotStore,
    private readonly options: CandidatePromotionOptions,
  ) {}

  static async open(
    root: string,
    manager: CandidateWorktreeManager,
    store: RepositorySnapshotStore,
    options: CandidatePromotionOptions = {},
  ): Promise<CandidatePromotion> {
    const ownedRoot = await ensurePrivateDirectory(resolve(root));
    return new CandidatePromotion(
      await ensurePrivateDirectory(join(ownedRoot, "records")),
      await ensurePrivateDirectory(join(ownedRoot, "locks")),
      manager,
      store,
      options,
    );
  }

  async recordScored(score: CandidatePromotionScore): Promise<void> {
    const pair = await this.manager.getPairForPromotion(score.requestId, score.winnerCandidateIndex);
    if (score.expectedSnapshotId !== pair.snapshotId) throw new CandidatePromotionError("invalid_receipt");
    const record = validatedRecord(Buffer.from(JSON.stringify({ ...score, state: "scored" })));
    await withFileLock(this.locksRoot, pair.sourceRepositoryRoot, async () => {
      const existing = await this.getRecord(score.requestId);
      if (existing !== undefined) {
        if (existing.state === "scored" && samePromotionScore(existing, record)) return;
        throw new CandidatePromotionError("already_promoted");
      }
      await this.writeRecord(record);
    });
  }

  async promote(requestId: string): Promise<CandidatePromotionRecord> {
    const pair = await this.manager.getPair(requestId);
    if (pair === undefined) throw new CandidatePromotionError("invalid_receipt");
    return withFileLock(this.locksRoot, pair.sourceRepositoryRoot, () => this.promoteLocked(requestId));
  }

  async getRecord(requestId: string): Promise<CandidatePromotionRecord | undefined> {
    if (!validRequestId(requestId)) throw new CandidatePromotionError("invalid_receipt");
    try {
      return await readWorkspaceManifest(
        this.recordPath(requestId),
        parsePromotionRecord,
        "candidate promotion receipt is not a regular file",
      );
    } catch (error) {
      if (error instanceof CandidatePromotionRecordError) {
        throw new CandidatePromotionError("invalid_receipt", error);
      }
      throw error;
    }
  }

  private async promoteLocked(requestId: string): Promise<CandidatePromotionRecord> {
    const scored = await this.getRecord(requestId);
    if (scored === undefined) throw new CandidatePromotionError("invalid_receipt");
    if (scored.state === "promoted" || scored.state === "promoting") {
      throw new CandidatePromotionError("already_promoted");
    }
    await this.writeRecord({ ...scored, state: "promoting" });
    const transaction = await this.openTransaction(scored);
    try {
      const terminal = await this.publish(scored, transaction);
      await this.writeRecord(terminal);
      return terminal;
    } catch (error) {
      await this.writeRecord({ ...scored, state: "scored" });
      if (error instanceof Error) throw classifyPromotionError(error);
      throw error;
    } finally {
      await transaction.close();
    }
  }

  private async openTransaction(scored: CandidatePromotionScore): Promise<SourceTreeTransaction> {
    try {
      assertSafeScore(scored);
      const pair = await this.manager.getPairForPromotion(scored.requestId, scored.winnerCandidateIndex);
      const winner = pair.candidates[scored.winnerCandidateIndex];
      if (
        pair.snapshotId !== scored.expectedSnapshotId
        || winner.status.kind !== "winner"
        || winner.status.finalized
        || getRepositoryHead(winner.workspacePath) !== pair.baselineHead
        || await getRepositoryRoot(winner.workspacePath) !== await realpath(winner.workspacePath)
      ) throw new CandidatePromotionError("unsafe_candidate");
      return await SourceTreeTransaction.open(pair.sourceRepositoryRoot);
    } catch (error) {
      await this.writeRecord({ ...scored, state: "scored" });
      if (error instanceof Error) throw classifyPromotionError(error);
      throw error;
    }
  }

  private async publish(
    scored: CandidatePromotionScore,
    transaction: SourceTreeTransaction,
  ): Promise<CandidatePromotionRecord> {
    const pair = await this.manager.getPairForPromotion(scored.requestId, scored.winnerCandidateIndex);
    const sourceRoot = pair.sourceRepositoryRoot;
    const winnerRoot = pair.candidates[scored.winnerCandidateIndex].workspacePath;
    const current = await this.store.capture(sourceRoot);
    if (
      current.snapshotId !== scored.expectedSnapshotId
      || current.baselineHead !== pair.baselineHead
    ) throw new CandidatePromotionError("source_changed");
    await transaction.assertSourceUnchanged(() => new CandidatePromotionError("source_changed"));
    const delta = await repositoryDelta(sourceRoot, winnerRoot);
    const receipt = scored.scoreReceipts[scored.winnerCandidateIndex];
    if (
      delta.bytes !== receipt.changedByteCount
      || !sameStrings(delta.paths, receipt.changedPaths)
    ) throw new CandidatePromotionError("invalid_receipt");
    let finalSnapshotId: string | undefined;
    await transaction.publish(
      delta.paths,
      (stagedRoot) => applyDelta(stagedRoot, winnerRoot, delta.paths),
      async (stagedRoot) => {
        await applyDelta(
          sourceRoot,
          stagedRoot,
          delta.paths,
          this.options.beforePublishPath,
          (path) => transaction.assertPathUnchanged(
            path,
            () => new CandidatePromotionError("source_changed"),
          ),
        );
        finalSnapshotId = (await this.store.capture(sourceRoot)).snapshotId;
      },
    );
    if (finalSnapshotId === undefined) throw new CandidatePromotionError("publish_failed");
    return { ...scored, state: "promoted", finalSnapshotId };
  }

  private async writeRecord(record: CandidatePromotionRecord): Promise<void> {
    await replaceWorkspaceManifest(this.recordPath(record.requestId), Buffer.from(`${JSON.stringify(record)}\n`));
  }

  private recordPath(requestId: string): string {
    return join(this.recordsRoot, `${requestId}.json`);
  }
}

function assertSafeScore(score: CandidatePromotionScore): void {
  if (!score.effects.fullyKnown || !score.effects.fullyCompensable) {
    throw new CandidatePromotionError("unsafe_effects");
  }
  const eligible = score.scoreReceipts.filter((receipt) => receipt.eligible).slice().sort(compareReceipts);
  const deterministicWinner = eligible[0];
  if (deterministicWinner === undefined) {
    throw new CandidatePromotionError("invalid_receipt");
  }
  const tied = eligible.filter((receipt) => sameScore(receipt, deterministicWinner));
  if (tied.length === 1 && deterministicWinner.candidateIndex === score.winnerCandidateIndex) return;
  if (
    tied.length !== 2
    || score.tieDecision === undefined
    || score.tieDecision.winnerCandidateIndex !== score.winnerCandidateIndex
  ) throw new CandidatePromotionError("invalid_receipt");
}

function compareReceipts(left: CandidateScoreReceipt, right: CandidateScoreReceipt): number {
  const length = Math.max(left.score.length, right.score.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left.score[index] ?? 0) - (right.score[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.candidateIndex - right.candidateIndex;
}

function sameScore(left: CandidateScoreReceipt, right: CandidateScoreReceipt): boolean {
  return left.score.length === right.score.length
    && left.score.every((value, index) => value === right.score[index]);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validatedRecord(bytes: Uint8Array): CandidatePromotionRecord {
  try {
    return parsePromotionRecord(bytes);
  } catch (error) {
    if (error instanceof CandidatePromotionRecordError) {
      throw new CandidatePromotionError("invalid_receipt", error);
    }
    throw error;
  }
}
function classifyPromotionError(error: unknown): CandidatePromotionError {
  if (error instanceof CandidatePromotionError) return error;
  if (error instanceof CandidatePromotionRecordError) return new CandidatePromotionError("invalid_receipt", error);
  if (error instanceof CandidatePromotionFileError) return new CandidatePromotionError("unsafe_candidate", error);
  if (error instanceof SourceTreeTransactionError && error.operation === "snapshot") {
    return new CandidatePromotionError("source_changed", error);
  }
  if (error instanceof RepositorySnapshotStoreError) {
    if (error.code === "source-changed") return new CandidatePromotionError("source_changed", error);
    if (error.code === "unsafe-entry") return new CandidatePromotionError("unsafe_candidate", error);
  }
  return new CandidatePromotionError("publish_failed", error);
}

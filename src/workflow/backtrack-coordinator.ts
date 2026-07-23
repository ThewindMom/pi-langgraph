import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import {
  CandidateTieCriticError,
  type CandidateTieCritic,
} from "./candidate-scoring.ts";
import {
  CandidatePromotionError,
  type CandidatePromotion,
  type CandidatePromotionScore,
} from "../repository/candidate-promotion.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import type { CandidateWorktreeManager } from "../workspace/candidate-worktree-manager.ts";
import { validateLexicalId } from "../workspace/format.ts";
import {
  cloneCandidateCheckpoints,
  initializeCoordinatorState,
  runCandidatePair,
} from "./backtrack-coordinator-candidates.ts";
import {
  assertSameRequest,
  coordinatorOutcome,
  otherCandidate,
  scoreCompletedCandidates,
} from "./backtrack-coordinator-helpers.ts";
import { BacktrackCoordinatorStore } from "./backtrack-coordinator-store.ts";
import {
  type BacktrackCoordinatorOutcome,
  type BacktrackCoordinatorState,
  BacktrackCoordinatorError,
  type CandidateEvidenceReceipt,
  type CandidateRunner,
  type CoordinateBacktrackInput,
  type CoordinatorDurableStage,
  type CoordinatorTerminal,
} from "./backtrack-coordinator-types.ts";

export type BacktrackCoordinatorDependencies = Readonly<{
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  candidateManager: CandidateWorktreeManager;
  promotion: CandidatePromotion;
  runner: CandidateRunner;
  tieCritic?: CandidateTieCritic;
  retainEvidence?: (ownerId: string, receipt: CandidateEvidenceReceipt) => Promise<void>;
  releaseEvidenceOwners?: (ownerIds: readonly string[]) => Promise<void>;
  onDurableStage?: (stage: CoordinatorDurableStage) => Promise<void>;
}>;

export class BacktrackCoordinator {
  private constructor(
    private readonly store: BacktrackCoordinatorStore,
    private readonly dependencies: BacktrackCoordinatorDependencies,
  ) {}

  static async open(root: string, dependencies: BacktrackCoordinatorDependencies): Promise<BacktrackCoordinator> {
    return new BacktrackCoordinator(await BacktrackCoordinatorStore.open(root), dependencies);
  }

  async run(input: CoordinateBacktrackInput): Promise<BacktrackCoordinatorOutcome> {
    validateLexicalId(input.preflight.requestId, "backtrack request ID");
    return this.store.locked(input.preflight.requestId, () => this.runLocked(input));
  }

  private async runLocked(input: CoordinateBacktrackInput): Promise<BacktrackCoordinatorOutcome> {
    let state = await this.store.read(input.preflight.requestId);
    if (state === undefined) state = await initializeCoordinatorState(input, this.dependencies, this.store);
    assertSameRequest(state, input);
    if (state.terminal !== null) return this.finalizeTerminal(state);

    if (!state.candidatesCreated) {
      const snapshot = await this.dependencies.snapshotStore.capture(state.sourceDirectory);
      if (snapshot.snapshotId !== state.snapshotId) throw new BacktrackCoordinatorError("source changed after preflight");
      await this.dependencies.candidateManager.createPair({
        requestId: state.requestId,
        sourceCwd: state.sourceDirectory,
        sourceThreadId: state.sourceThreadId,
        checkpointId: state.checkpointId,
        retentionOwnerIds: state.candidateThreadIds,
        snapshot,
        snapshotStore: this.dependencies.snapshotStore,
      });
      state = { ...state, candidatesCreated: true };
      await this.persist(state, "candidates-created");
    }

    state = await cloneCandidateCheckpoints(state, this.dependencies, this.store, (stage) => this.stage(stage));
    if (state.candidates.some((candidate) => candidate.status === "running" && candidate.receipt === null)) {
      return this.terminalize(state, { kind: "needs_attention", reason: "candidate_interrupted" });
    }
    state = await runCandidatePair(state, this.dependencies, this.store, (stage) => this.stage(stage));
    if (state.candidates.some((candidate) => candidate.status === "failed")) {
      return this.terminalize(state, { kind: "needs_attention", reason: "candidate_failed" });
    }
    if (state.score === null) {
      let scored;
      try {
        scored = await scoreCompletedCandidates(state, this.dependencies.tieCritic);
      } catch (error) {
        if (error instanceof CandidateTieCriticError) {
          return this.terminalize(state, { kind: "needs_attention", reason: "tie_critic_failed" });
        }
        throw error;
      }
      if (scored === null) {
        return this.terminalize(state, { kind: "needs_attention", reason: "no_eligible_candidate" });
      }
      state = { ...state, score: scored };
      await this.persist(state, "scored");
    }
    return this.promote(state);
  }

  private async promote(state: BacktrackCoordinatorState): Promise<BacktrackCoordinatorOutcome> {
    const score = state.score;
    if (score === null) throw new BacktrackCoordinatorError("promotion requires a durable score");
    const winner = score.winnerCandidateIndex;
    await this.dependencies.candidateManager.setStatus(state.requestId, winner, {
      protocolVersion: 1, kind: "winner", finalized: false,
    });
    await this.dependencies.candidateManager.setStatus(state.requestId, otherCandidate(winner), {
      protocolVersion: 1, kind: "loser",
    });
    const existing = await this.dependencies.promotion.getRecord(state.requestId);
    if (existing?.state === "promoted") {
      return this.terminalize(state, {
        kind: "promoted", winnerCandidateIndex: winner, finalSnapshotId: existing.finalSnapshotId,
      });
    }
    if (existing?.state === "promoting") {
      return this.terminalize(state, { kind: "needs_attention", reason: "promotion_incomplete" });
    }
    const winnerReceipt = state.candidates[winner].receipt;
    if (winnerReceipt === null) throw new BacktrackCoordinatorError("winner receipt is missing");
    const promotionScore: CandidatePromotionScore = {
      protocolVersion: 1,
      requestId: state.requestId,
      expectedSnapshotId: state.snapshotId,
      winnerCandidateIndex: winner,
      scoreReceipts: score.receipts,
      effects: winnerReceipt.effects,
      ...(score.tieDecision === null ? {} : { tieDecision: score.tieDecision }),
    };
    try {
      if (existing === undefined) await this.dependencies.promotion.recordScored(promotionScore);
      const promoted = await this.dependencies.promotion.promote(state.requestId);
      if (promoted.state !== "promoted") throw new BacktrackCoordinatorError("promotion did not terminalize");
      return this.terminalize(state, {
        kind: "promoted", winnerCandidateIndex: winner, finalSnapshotId: promoted.finalSnapshotId,
      });
    } catch (error) {
      if (error instanceof CandidatePromotionError) {
        const recovered = await this.dependencies.promotion.getRecord(state.requestId);
        if (recovered?.state === "promoted") {
          return this.terminalize(state, {
            kind: "promoted", winnerCandidateIndex: winner, finalSnapshotId: recovered.finalSnapshotId,
          });
        }
        return this.terminalize(state, { kind: "needs_attention", reason: "promotion_failed" });
      }
      throw error;
    }
  }

  private async terminalize(
    state: BacktrackCoordinatorState,
    terminal: CoordinatorTerminal,
  ): Promise<BacktrackCoordinatorOutcome> {
    const durable = { ...state, terminal };
    await this.persist(durable, terminal.kind === "promoted" ? "promoted" : "needs-attention");
    return this.finalizeTerminal(durable);
  }

  private async finalizeTerminal(state: BacktrackCoordinatorState): Promise<BacktrackCoordinatorOutcome> {
    const terminal = state.terminal;
    if (terminal === null) throw new BacktrackCoordinatorError("terminal outcome is missing");
    if (state.cleanupCompleted) return coordinatorOutcome(state);
    const pair = await this.dependencies.candidateManager.getPair(state.requestId);
    let releaseOwnerIds: readonly string[] = [];
    if (pair !== undefined) {
      if (terminal.kind === "promoted") {
        await this.dependencies.candidateManager.setStatus(state.requestId, terminal.winnerCandidateIndex, {
          protocolVersion: 1, kind: "winner", finalized: true,
        });
        const loser = otherCandidate(terminal.winnerCandidateIndex);
        await this.dependencies.candidateManager.setStatus(state.requestId, loser, {
          protocolVersion: 1, kind: "loser",
        });
        await this.dependencies.candidateManager.setPinned(state.requestId, loser, false);
      } else {
        for (const index of [0, 1] as const) {
          await this.dependencies.candidateManager.setStatus(state.requestId, index, { protocolVersion: 1, kind: "completed" });
        }
      }
      releaseOwnerIds = (await this.dependencies.candidateManager.cleanupExpired()).releaseOwnerIds;
    }
    for (const ownerId of releaseOwnerIds) await this.dependencies.checkpoints.deleteThread(ownerId);
    await this.dependencies.releaseEvidenceOwners?.(releaseOwnerIds);
    const retainedPair = await this.dependencies.candidateManager.getPair(state.requestId);
    const cleanupCompleted = retainedPair === undefined
      || terminal.kind !== "promoted"
      || retainedPair.candidates[otherCandidate(terminal.winnerCandidateIndex)].removedAtMs !== null;
    if (!state.cleanupAttempted || cleanupCompleted !== state.cleanupCompleted) {
      await this.store.write({ ...state, cleanupAttempted: true, cleanupCompleted });
    }
    if (!state.cleanupAttempted) {
      await this.stage("cleanup-attempted");
    }
    return coordinatorOutcome(state);
  }

  private async persist(state: BacktrackCoordinatorState, stage: CoordinatorDurableStage): Promise<void> {
    await this.store.write(state);
    await this.stage(stage);
  }

  private async stage(stage: CoordinatorDurableStage): Promise<void> {
    await this.dependencies.onDurableStage?.(stage);
  }
}

export type {
  AcceptedBacktrackPreflight,
  BacktrackCandidateIndex,
  BacktrackCandidateVariant,
  BacktrackCoordinatorError,
  BacktrackCoordinatorOutcome,
  CandidateEvidenceReceipt,
  CandidateRunner,
  CandidateRunnerReceipt,
  CoordinateBacktrackInput,
  CoordinatorDurableStage,
} from "./backtrack-coordinator-types.ts";

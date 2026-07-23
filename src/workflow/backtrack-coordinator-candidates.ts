import { createHash } from "node:crypto";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import type { CandidateWorktreeManager } from "../workspace/candidate-worktree-manager.ts";
import { BacktrackCoordinatorStore } from "./backtrack-coordinator-store.ts";
import {
  BACKTRACK_CANDIDATE_VARIANTS,
  type BacktrackCandidateIndex,
  BacktrackCoordinatorError,
  type BacktrackCoordinatorState,
  type CandidateEvidenceReceipt,
  type CandidateRunner,
  type CandidateRunnerReceipt,
  type CoordinateBacktrackInput,
  type CoordinatorDurableStage,
} from "./backtrack-coordinator-types.ts";
import { cloneWorkflowCheckpoint } from "./forks.ts";

export type CandidatePhaseDependencies = Readonly<{
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  candidateManager: CandidateWorktreeManager;
  runner: CandidateRunner;
  retainEvidence?: (ownerId: string, receipt: CandidateEvidenceReceipt) => Promise<void>;
}>;

export async function initializeCoordinatorState(
  input: CoordinateBacktrackInput,
  dependencies: CandidatePhaseDependencies,
  store: BacktrackCoordinatorStore,
): Promise<BacktrackCoordinatorState> {
  const snapshot = await dependencies.snapshotStore.capture(input.sourceDirectory);
  if (snapshot.snapshotId !== input.preflight.sourceSnapshotIdAtAcceptance) {
    throw new BacktrackCoordinatorError("accepted preflight snapshot does not match source");
  }
  const candidateThreadIds = candidateThreads(input.preflight.requestId);
  const pending = Object.freeze({ status: "pending", receipt: null, failure: null } as const);
  const state: BacktrackCoordinatorState = {
    protocolVersion: 1,
    requestId: input.preflight.requestId,
    sourceDirectory: input.sourceDirectory,
    sourceThreadId: input.preflight.threadId,
    checkpointId: input.preflight.checkpointId,
    snapshotId: input.preflight.sourceSnapshotIdAtAcceptance,
    candidateThreadIds,
    variants: BACKTRACK_CANDIDATE_VARIANTS,
    candidatesCreated: false,
    checkpointsCloned: [false, false],
    candidates: [pending, pending],
    score: null,
    terminal: null,
    cleanupAttempted: false,
    cleanupCompleted: false,
  };
  await store.write(state);
  return state;
}

export async function cloneCandidateCheckpoints(
  state: BacktrackCoordinatorState,
  dependencies: CandidatePhaseDependencies,
  store: BacktrackCoordinatorStore,
  stage: (stage: CoordinatorDurableStage) => Promise<void>,
): Promise<BacktrackCoordinatorState> {
  let current = state;
  for (const candidateIndex of [0, 1] as const) {
    if (current.checkpointsCloned[candidateIndex]) continue;
    await cloneWorkflowCheckpoint({
      checkpointer: dependencies.checkpoints,
      sourceThreadId: current.sourceThreadId,
      checkpointId: current.checkpointId,
      forkThreadId: current.candidateThreadIds[candidateIndex],
    });
    const checkpointsCloned = candidateIndex === 0
      ? [true, current.checkpointsCloned[1]] as const
      : [current.checkpointsCloned[0], true] as const;
    current = { ...current, checkpointsCloned };
    await store.write(current);
  }
  if (!state.checkpointsCloned.every(Boolean)) await stage("checkpoints-cloned");
  return current;
}

export async function runCandidatePair(
  state: BacktrackCoordinatorState,
  dependencies: CandidatePhaseDependencies,
  store: BacktrackCoordinatorStore,
  stage: (stage: CoordinatorDurableStage) => Promise<void>,
): Promise<BacktrackCoordinatorState> {
  const pair = await dependencies.candidateManager.getPair(state.requestId);
  if (pair === undefined) throw new BacktrackCoordinatorError("candidate pair disappeared");
  let current = state;
  const runnable = ([0, 1] as const).filter((index) => current.candidates[index].status === "pending");
  if (runnable.length === 0) return current;
  for (const index of runnable) current = replaceCandidate(current, index, "running", null, null);
  await store.write(current);
  let persistence = Promise.resolve();
  const record = async (
    index: BacktrackCandidateIndex,
    status: "completed" | "failed",
    receipt: CandidateRunnerReceipt | null,
    failure: string | null,
  ): Promise<void> => {
    const update = persistence.then(async () => {
      current = replaceCandidate(current, index, status, receipt, failure);
      await store.write(current);
    });
    persistence = update;
    await update;
  };
  await Promise.all(runnable.map(async (index) => {
    try {
      const receipt = await dependencies.runner(
        index,
        state.candidateThreadIds[index],
        pair.candidates[index].workspacePath,
        state.variants[index],
      );
      await dependencies.retainEvidence?.(state.candidateThreadIds[index], receipt.evidence);
      await record(index, "completed", receipt, null);
    } catch (error) {
      if (error instanceof Error) {
        await record(index, "failed", null, errorText(error));
        return;
      }
      throw error;
    }
  }));
  if (current.candidates.every((candidate) => candidate.status === "completed")) {
    await stage("candidates-completed");
  }
  return current;
}

function replaceCandidate(
  state: BacktrackCoordinatorState,
  index: BacktrackCandidateIndex,
  status: "running" | "completed" | "failed",
  receipt: CandidateRunnerReceipt | null,
  failure: string | null,
): BacktrackCoordinatorState {
  const candidate = { status, receipt, failure } as const;
  const candidates = index === 0
    ? [candidate, state.candidates[1]] as const
    : [state.candidates[0], candidate] as const;
  return { ...state, candidates };
}

function candidateThreads(requestId: string): readonly [string, string] {
  const base = `backtrack-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
  return [`${base}-candidate-0`, `${base}-candidate-1`];
}

function errorText(error: Error): string {
  return `${error.name}: ${error.message}`;
}

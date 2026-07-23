import { sha256CanonicalJson } from "../bridge/canonical.ts";
import { createRepositoryExecutionPolicy, createTaskExecutor } from "../executors.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { repositoryDelta } from "../repository/candidate-promotion-files.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import type {
  ExecutionRequest,
  LangGraphExtensionAPI,
  RuntimeContext,
  TaskExecutor,
  WorkerResult,
} from "../types.ts";
import {
  type BacktrackCandidateVariant,
  type CandidateRunner,
  type CandidateRunnerReceipt,
} from "../workflow/backtrack-coordinator.ts";
import {
  assessAutomaticBacktrackSafety,
  type EffectLedger,
} from "../workflow/effect-ledger.ts";
import { resumeCodingWorkflow } from "../workflow/runtime.ts";
import type { CodingRunResult, CodingWorkflowResult } from "../workflow/types.ts";
import { bindNewWorkflowReplay } from "./replay-context.ts";
import { RepositoryServices } from "./repository-services.ts";

export type RuntimeCandidateRunnerInput = Readonly<{
  pi: LangGraphExtensionAPI;
  context: RuntimeContext;
  dataRoot: string;
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  sourceDirectory: string;
  workflowInput: unknown;
  effectLedger: EffectLedger;
  signal?: AbortSignal;
}>;

export function createRuntimeCandidateRunner(
  input: RuntimeCandidateRunnerInput,
): CandidateRunner {
  return async (candidateIndex, threadId, workspacePath, variant) => {
    const context = { ...input.context, cwd: workspacePath };
    const policy = createRepositoryExecutionPolicy(input.pi, context);
    const executor = variantExecutor(createTaskExecutor(input.pi, context), variant);
    const services = await RepositoryServices.open(input.dataRoot, workspacePath, {
      executor,
      policy,
      threadId,
    });
    await bindNewWorkflowReplay({
      checkpoints: input.checkpoints,
      snapshotStore: input.snapshotStore,
      threadId,
      sourceDirectory: workspacePath,
      workflowInput: input.workflowInput,
      policy,
      effectLedger: input.effectLedger,
    });
    const result = await resumeCodingWorkflow(threadId, services.executor, {
      checkpointer: input.checkpoints,
      retainCheckpoint: true,
      evidenceRunner: services.evidenceRunner,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    await recordCandidateResult(input.checkpoints, services, result);
    const delta = await repositoryDelta(input.sourceDirectory, workspacePath);
    return candidateReceipt(candidateIndex, threadId, result, delta, input.effectLedger);
  };
}

function variantExecutor(
  delegate: TaskExecutor,
  variant: BacktrackCandidateVariant,
): TaskExecutor {
  return {
    execute(request, signal, options) {
      return delegate.execute(withVariant(request, variant), signal, options);
    },
  };
}

function withVariant(
  request: ExecutionRequest,
  variant: BacktrackCandidateVariant,
): ExecutionRequest {
  const marker: WorkerResult = {
    id: "automatic_backtrack_variant",
    status: "completed",
    output: JSON.stringify({ protocolVersion: 1, variant }),
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(0).toISOString(),
  };
  return {
    ...request,
    dependencyResults: [...request.dependencyResults, marker],
  };
}

async function recordCandidateResult(
  checkpoints: FileCheckpointSaver,
  services: RepositoryServices,
  result: CodingRunResult,
): Promise<void> {
  const tuple = await checkpoints.getTuple({
    configurable: { thread_id: result.threadId },
  });
  if (tuple === undefined) throw new CandidateRunnerError("candidate checkpoint is missing");
  await services.recordResult(result, tuple.checkpoint.id, tuple);
}

function candidateReceipt(
  candidateIndex: 0 | 1,
  threadId: string,
  result: CodingRunResult,
  delta: Readonly<{ paths: readonly string[]; bytes: number }>,
  ledger: EffectLedger,
): CandidateRunnerReceipt {
  const delivery = result.status !== "awaiting_approval" && result.pattern === "delivery"
    ? result
    : undefined;
  const verification = delivery?.verification;
  const effectsSafe = assessAutomaticBacktrackSafety(ledger).kind === "safe";
  const refs = result.status === "awaiting_approval" ? [] : result.evidenceRefs;
  return {
    score: {
      replayCompatible: true,
      deliveryCompleted: delivery?.status === "completed",
      hostVerification: {
        passed: verification?.passed === true,
        failedChecks: verification?.checks.filter((check) => !check.passed).length ?? 1,
      },
      unresolvedRisks: delivery?.unresolvedRisks ?? ["candidate-awaiting-approval"],
      changedPaths: delta.paths,
      changedBytes: delta.bytes,
      checkFailures: verificationFailures(delivery),
      unmetAcceptanceCriteria: verification?.passed === true ? 0 : 1,
      regressions: verification?.checks.filter((check) =>
        !check.passed && check.name.toLowerCase().includes("regression")
      ).length ?? 0,
      summary: result.summary ?? "candidate awaiting approval",
    },
    effects: {
      fullyKnown: effectsSafe,
      fullyCompensable: effectsSafe,
    },
    evidence: {
      protocolVersion: 1,
      receiptId: `candidate-${sha256CanonicalJson({
        candidateIndex,
        threadId,
        status: result.status,
        verification,
        delta,
        refs,
      }).slice(0, 48)}`,
      artifactRefs: refs,
    },
  };
}

function verificationFailures(
  result: CodingWorkflowResult | undefined,
): Readonly<{ test: number; typecheck: number; lint: number; build: number }> {
  const failures = { test: 0, typecheck: 0, lint: 0, build: 0 };
  for (const check of result?.verification?.checks ?? []) {
    if (check.passed) continue;
    const name = check.name.toLowerCase();
    if (name.includes("type")) failures.typecheck += 1;
    else if (name.includes("lint")) failures.lint += 1;
    else if (name.includes("build")) failures.build += 1;
    else failures.test += 1;
  }
  return failures;
}

class CandidateRunnerError extends Error {
  readonly name = "CandidateRunnerError";
}

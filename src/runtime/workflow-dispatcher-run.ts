import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createRepositoryExecutionPolicy, createTaskExecutor } from "../executors.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import type { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import {
  DEFAULT_AGENT_TOOL,
  type LangGraphExtensionAPI,
} from "../types.ts";
import {
  resumeCodingWorkflow,
  ResumeCheckpointSelectionError,
  runCodingWorkflow,
} from "../workflow/runtime.ts";
import type {
  CodingRunResult,
  CodingWorkflowInput,
} from "../workflow/types.ts";
import type { WorktreeManager } from "../workspace/worktree-manager.ts";
import {
  runAutomaticBacktrack,
} from "./automatic-backtrack.ts";
import { createRuntimeCandidateRunner } from "./candidate-runner.ts";
import { createRuntimeTieCritic } from "./tie-critic.ts";
import type {
  ExtensionDetails,
  OrchestrationDispatchRequest,
  OrchestrationDispatcherObserver,
} from "./orchestration-dispatcher.ts";
import {
  assertResumeReplayCompatible,
  bindNewWorkflowReplay,
  ReplayResumeRejectedError,
} from "./replay-context.ts";
import { RepositoryServices } from "./repository-services.ts";
import { assertActiveResumeTarget } from "./active-resume-target.ts";
import { taskExecutionEffectLedger } from "./task-execution-effects.ts";
import type { EffectLedger } from "../workflow/effect-ledger.ts";
import {
  type AutomaticBacktrackWorkflowDetails,
  recordWorkflowResult,
  startedUpdate,
  workflowCallbacks,
  workflowEnvelope,
} from "./workflow-dispatcher-presenter.ts";

export type WorkflowDispatchDependencies = Readonly<{
  pi: OrchestrationPi;
  dataRoot: string;
  checkpoints: FileCheckpointSaver;
  snapshotStore: RepositorySnapshotStore;
  worktrees: WorktreeManager;
  observer?: OrchestrationDispatcherObserver;
}>;

type OrchestrationPi = LangGraphExtensionAPI;

export async function dispatchWorkflow(
  request: OrchestrationDispatchRequest,
  dependencies: WorkflowDispatchDependencies,
): Promise<AgentToolResult<ExtensionDetails>> {
  const native = dependencies.pi.executeTool !== undefined &&
    dependencies.pi.getActiveTools().includes(DEFAULT_AGENT_TOOL);
  if ("resumeThreadId" in request.input) {
    return resumeWorkflow(request, dependencies, native);
  }
  return startWorkflow(request, dependencies, native);
}

async function startWorkflow(
  request: OrchestrationDispatchRequest,
  dependencies: WorkflowDispatchDependencies,
  native: boolean,
): Promise<AgentToolResult<ExtensionDetails>> {
  const input = request.input;
  if ("resumeThreadId" in input || "action" in input) {
    throw new WorkflowDispatchError("new workflow input expected");
  }
  const threadId = input.threadId ?? crypto.randomUUID();
  const workflowInput: CodingWorkflowInput = {
    objective: input.objective,
    ...(input.workflow === undefined ? {} : { workflow: input.workflow }),
    ...(input.maxIterations === undefined ? {} : { maxIterations: input.maxIterations }),
    ...(input.approval === undefined ? {} : { approval: input.approval }),
  };
  const policy = createRepositoryExecutionPolicy(dependencies.pi, request.context);
  const effectLedger = taskExecutionEffectLedger(dependencies.pi);
  const services = await RepositoryServices.open(
    dependencies.dataRoot,
    request.context.cwd,
    {
      executor: createTaskExecutor(dependencies.pi, request.context),
      policy,
      threadId,
    },
  );
  await bindNewWorkflowReplay({
    checkpoints: dependencies.checkpoints,
    snapshotStore: dependencies.snapshotStore,
    threadId,
    sourceDirectory: request.context.cwd,
    workflowInput,
    policy,
    effectLedger,
  });
  request.onUpdate?.(startedUpdate(threadId, input.objective));
  const callbacks = workflowCallbacks(
    request.onUpdate,
    dependencies.observer,
    request.context,
    input.objective,
  );
  const result = await runCodingWorkflow(workflowInput, services.executor, {
    checkpointer: dependencies.checkpoints,
    threadId,
    retainCheckpoint: true,
    evidenceRunner: services.evidenceRunner,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...callbacks.options,
  });
  await callbacks.flush();
  await recordWorkflowResult(dependencies.checkpoints, services, result);
  const details = await withAutomaticBacktrack(
    result,
    request,
    dependencies,
    workflowInput,
    effectLedger,
  );
  return workflowEnvelope(details, native);
}

async function resumeWorkflow(
  request: OrchestrationDispatchRequest,
  dependencies: WorkflowDispatchDependencies,
  native: boolean,
): Promise<AgentToolResult<ExtensionDetails>> {
  const input = request.input;
  if (!("resumeThreadId" in input)) {
    throw new WorkflowDispatchError("resume workflow input expected");
  }
  const activeLink = await dependencies.observer?.resolveActiveLink?.(request.context);
  const fork = await dependencies.worktrees.getFork(input.resumeThreadId);
  const cwd = fork?.workspacePath ?? request.context.cwd;
  const context = { ...request.context, cwd };
  const checkpointId = await assertActiveResumeTarget({
    activeLink,
    checkpoints: dependencies.checkpoints,
    threadId: input.resumeThreadId,
    cwd,
    forkWorkspacePath: fork?.workspacePath,
  });
  const policy = createRepositoryExecutionPolicy(dependencies.pi, context);
  const effectLedger = taskExecutionEffectLedger(dependencies.pi);
  const replay = await assertResumeReplayCompatible({
    checkpoints: dependencies.checkpoints,
    snapshotStore: dependencies.snapshotStore,
    threadId: input.resumeThreadId,
    sourceDirectory: cwd,
    policy,
    effectLedger,
  });
  const services = await RepositoryServices.open(dependencies.dataRoot, cwd, {
    executor: createTaskExecutor(dependencies.pi, context),
    policy,
    threadId: input.resumeThreadId,
  });
  await bindNewWorkflowReplay({
    checkpoints: dependencies.checkpoints,
    snapshotStore: dependencies.snapshotStore,
    threadId: input.resumeThreadId,
    sourceDirectory: cwd,
    workflowInput: replay.workflowInput,
    policy,
    effectLedger,
  });
  const callbacks = workflowCallbacks(
    request.onUpdate,
    dependencies.observer,
    context,
    "resumed workflow",
  );
  let result: CodingRunResult;
  try {
    result = await resumeCodingWorkflow(input.resumeThreadId, services.executor, {
      checkpointer: dependencies.checkpoints,
      retainCheckpoint: true,
      evidenceRunner: services.evidenceRunner,
      ...(checkpointId === undefined ? {} : { checkpointId }),
      ...(input.decision === undefined ? {} : { decision: input.decision }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...callbacks.options,
    });
  } catch (error) {
    if (error instanceof ResumeCheckpointSelectionError) {
      throw new ReplayResumeRejectedError("active-checkpoint-requires-fork");
    }
    throw error;
  }
  await callbacks.flush();
  await recordWorkflowResult(dependencies.checkpoints, services, result);
  const details = await withAutomaticBacktrack(
    result,
    { ...request, context },
    dependencies,
    replay.workflowInput,
    effectLedger,
  );
  return workflowEnvelope(details, native);
}

async function withAutomaticBacktrack(
  result: CodingRunResult,
  request: OrchestrationDispatchRequest,
  dependencies: WorkflowDispatchDependencies,
  workflowInput: unknown,
  effectLedger: EffectLedger,
): Promise<CodingRunResult | AutomaticBacktrackWorkflowDetails> {
  if (result.status !== "needs_attention") return result;
  const automaticBacktrack = await runAutomaticBacktrack({
    dataRoot: dependencies.dataRoot,
    checkpoints: dependencies.checkpoints,
    snapshotStore: dependencies.snapshotStore,
    sourceDirectory: request.context.cwd,
    result,
    effectLedger,
    runner: createRuntimeCandidateRunner({
      pi: dependencies.pi,
      context: request.context,
      dataRoot: dependencies.dataRoot,
      checkpoints: dependencies.checkpoints,
      snapshotStore: dependencies.snapshotStore,
      sourceDirectory: request.context.cwd,
      workflowInput,
      effectLedger,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
    tieCritic: createRuntimeTieCritic({
      pi: dependencies.pi,
      context: request.context,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }),
  });
  return { ...result, automaticBacktrack };
}

class WorkflowDispatchError extends Error {
  readonly name = "WorkflowDispatchError";
}

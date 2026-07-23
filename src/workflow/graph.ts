import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ExecutionRequest, WorkerTask } from "../types.ts";
import { RepositoryIsolationError } from "../repository/mutation-scope.ts";
import type {
  MutationExecution,
  MutationJournal,
  MutationOperation,
} from "../persistence/mutation-journal.ts";
import {
  classifyNode,
  collectNode,
  createPrepareChangeNode,
  dispatchNode,
  escalateNode,
  routeDispatch,
  routePreparedChange,
} from "./routing-nodes.ts";
import type { WorkflowRuntimeDependencies } from "./types.ts";
import { compileChangeSubgraph } from "./change-subgraph.ts";
import {
  createDiagnoseNode,
  createDiscoverNode,
  createRepairNode,
  createSpecialistNode,
  createSynthesizeNode,
  createVerifyNode,
} from "./worker-nodes.ts";
import { SpecialistOutput, SpecialistState, WorkflowState } from "./workflow-state.ts";

export { WorkflowState } from "./workflow-state.ts";
export type { WorkflowStateValue } from "./workflow-state.ts";

const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1_000;

export interface CompileCodingGraphOptions {
  readonly checkpointer: BaseCheckpointSaver;
  readonly mutationJournal: MutationJournal;
  readonly threadId: string;
}

export function compileCodingGraph(
  dependencies: WorkflowRuntimeDependencies,
  options: CompileCodingGraphOptions,
) {
  const timeout = dependencies.nodeTimeoutMs || DEFAULT_NODE_TIMEOUT_MS;
  const nodeTimeout = Math.min(Number.MAX_SAFE_INTEGER, timeout + 1_000);
  const retryPolicy = {
    maxAttempts: 2,
    initialInterval: 10,
    maxInterval: 25,
    jitter: false,
    logWarning: false,
    retryOn: shouldRetryWorkerError,
  };

  const execute = async (task: WorkerTask, objective: string): Promise<string> => {
    const total = 1;
    dependencies.onProgress?.({ taskId: task.id, status: "started", completed: 0, total });
    const request: ExecutionRequest = { objective, task, dependencyResults: [] };
    const timeoutController = new AbortController();
    const timeoutHandle = setTimeout(
      () => timeoutController.abort(new Error(`worker timed out after ${timeout}ms`)),
      timeout,
    );
    const executionSignal =
      dependencies.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([dependencies.signal, timeoutController.signal]);
    try {
      const output = await dependencies.executor.execute(request, executionSignal);
      dependencies.onProgress?.({ taskId: task.id, status: "completed", completed: 1, total });
      return output;
    } catch (error) {
      const message = error instanceof Error ? error.message : "worker failed with a non-Error value";
      dependencies.onProgress?.({
        taskId: task.id,
        status: "failed",
        completed: 0,
        total,
        message,
      });
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
    }
  };

  const executeMutation = async (
    task: WorkerTask,
    objective: string,
    operation: MutationOperation,
  ): Promise<MutationExecution> => {
    const claim = await options.mutationJournal.claimMutation(options.threadId, operation);
    if (claim.status === "indeterminate") return claim;
    if (claim.status === "replay") return { status: "completed", output: claim.output };
    const output = await execute(task, objective);
    await options.mutationJournal.completeMutation(options.threadId, operation, output);
    return { status: "completed", output };
  };

  const specialistSubgraph = new StateGraph({ stateSchema: SpecialistState, output: SpecialistOutput })
    .addNode("analyze", createSpecialistNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addEdge(START, "analyze")
    .addEdge("analyze", END)
    .compile({ name: "coding-specialist" });
  const changeSubgraph = compileChangeSubgraph({
    executeMutation,
    threadId: options.threadId,
    nodeTimeout,
    ...(dependencies.evidenceRunner === undefined ? {} : { evidenceRunner: dependencies.evidenceRunner }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });

  const graph = new StateGraph(WorkflowState)
    .addNode("classify", classifyNode)
    .addNode("discover", createDiscoverNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("specialist", specialistSubgraph, { input: SpecialistState })
    .addNode("dispatch", dispatchNode)
    .addNode("collect", collectNode)
    .addNode("prepare_change", createPrepareChangeNode(options.threadId))
    .addNode("change", changeSubgraph)
    .addNode(
      "verify",
      createVerifyNode(execute, dependencies.evidenceRunner, dependencies.signal),
      { retryPolicy, timeout: nodeTimeout, ends: ["synthesize", "diagnose", "escalate"] },
    )
    .addNode("diagnose", createDiagnoseNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("repair", createRepairNode(executeMutation), { timeout: nodeTimeout })
    .addNode("synthesize", createSynthesizeNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("escalate", escalateNode)
    .addEdge(START, "classify")
    .addEdge("classify", "discover")
    .addEdge("discover", "dispatch")
    .addConditionalEdges("dispatch", routeDispatch)
    .addEdge("specialist", "collect")
    .addEdge("collect", "dispatch")
    .addConditionalEdges("prepare_change", routePreparedChange)
    .addEdge("change", "prepare_change")
    .addEdge("diagnose", "repair")
    .addEdge("repair", "verify")
    .addEdge("synthesize", END)
    .addEdge("escalate", END);

  return graph.compile({ checkpointer: options.checkpointer, name: "pi-coding-workflow" });
}

export function shouldRetryWorkerError(error: unknown): boolean {
  return !(error instanceof RepositoryIsolationError);
}

import { END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ExecutionRequest, OrchestrationTask } from "../types.ts";
import { classifyNode, collectNode, dispatchNode, escalateNode, routeDispatch } from "./routing-nodes.ts";
import type { WorkflowRuntimeDependencies } from "./types.ts";
import {
  createDiagnoseNode,
  createDiscoverNode,
  createImplementNode,
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
  readonly interruptBeforeMutation?: boolean;
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
    retryOn: (_error: unknown) => true,
  };

  const execute = async (task: OrchestrationTask, objective: string): Promise<string> => {
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

  const specialistSubgraph = new StateGraph({ stateSchema: SpecialistState, output: SpecialistOutput })
    .addNode("analyze", createSpecialistNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addEdge(START, "analyze")
    .addEdge("analyze", END)
    .compile({ name: "coding-specialist" });

  const graph = new StateGraph(WorkflowState)
    .addNode("classify", classifyNode)
    .addNode("discover", createDiscoverNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("specialist", specialistSubgraph, { input: SpecialistState })
    .addNode("dispatch", dispatchNode)
    .addNode("collect", collectNode)
    .addNode("implement", createImplementNode(execute), { timeout: nodeTimeout })
    .addNode(
      "verify",
      createVerifyNode(execute),
      { retryPolicy, timeout: nodeTimeout, ends: ["synthesize", "diagnose", "escalate"] },
    )
    .addNode("diagnose", createDiagnoseNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("repair", createRepairNode(execute), { timeout: nodeTimeout })
    .addNode("synthesize", createSynthesizeNode(execute), { retryPolicy, timeout: nodeTimeout })
    .addNode("escalate", escalateNode)
    .addEdge(START, "classify")
    .addEdge("classify", "discover")
    .addEdge("discover", "dispatch")
    .addConditionalEdges("dispatch", routeDispatch)
    .addEdge("specialist", "collect")
    .addEdge("collect", "dispatch")
    .addEdge("implement", "verify")
    .addEdge("diagnose", "repair")
    .addEdge("repair", "verify")
    .addEdge("synthesize", END)
    .addEdge("escalate", END);

  return graph.compile({
    checkpointer: options.checkpointer,
    name: "pi-coding-workflow",
    ...(options.interruptBeforeMutation ? { interruptBefore: ["implement"] } : {}),
  });
}

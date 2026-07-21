import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { validatePlan } from "./plan.ts";
import type {
  OrchestrationPlan,
  OrchestrationResult,
  ProgressReporter,
  TaskExecutor,
  TaskResult,
} from "./types.ts";

const GraphState = Annotation.Root({
  results: Annotation<TaskResult[]>({
    reducer: (current, update) => current.concat(update),
    default: () => [],
  }),
});

type GraphStateValue = typeof GraphState.State;
type DynamicGraph = StateGraph<typeof GraphState> & {
  addNode(name: string, action: (state: GraphStateValue) => Promise<Partial<GraphStateValue>>): DynamicGraph;
  addEdge(start: string | string[], end: string): DynamicGraph;
};

export async function runOrchestration(
  plan: OrchestrationPlan,
  executor: TaskExecutor,
  options: { readonly signal?: AbortSignal; readonly onProgress?: ProgressReporter } = {},
): Promise<OrchestrationResult> {
  validatePlan(plan);
  const graph = new StateGraph(GraphState) as DynamicGraph;
  let completed = 0;

  for (const task of plan.tasks) {
    graph.addNode(task.id, async (state) => {
      const startedAt = new Date().toISOString();
      options.onProgress?.({ taskId: task.id, status: "started", completed, total: plan.tasks.length });
      const dependencyIds = new Set(task.dependsOn ?? []);
      const dependencyResults = state.results.filter((result) => dependencyIds.has(result.id));
      try {
        const output = await executor.execute(
          { objective: plan.objective, task, dependencyResults },
          options.signal,
        );
        completed += 1;
        const result: TaskResult = {
          id: task.id,
          status: "completed",
          output,
          startedAt,
          completedAt: new Date().toISOString(),
        };
        options.onProgress?.({ taskId: task.id, status: "completed", completed, total: plan.tasks.length });
        return { results: [result] };
      } catch (error) {
        completed += 1;
        const message = error instanceof Error ? error.message : String(error);
        options.onProgress?.({
          taskId: task.id,
          status: "failed",
          completed,
          total: plan.tasks.length,
          message,
        });
        if ((plan.failurePolicy ?? "fail-fast") === "fail-fast") throw error;
        return {
          results: [
            {
              id: task.id,
              status: "failed",
              error: message,
              startedAt,
              completedAt: new Date().toISOString(),
            },
          ],
        };
      }
    });
  }

  const dependants = new Map(plan.tasks.map((task) => [task.id, [] as string[]]));
  for (const task of plan.tasks) {
    const dependencies = [...(task.dependsOn ?? [])];
    if (dependencies.length === 0) graph.addEdge(START, task.id);
    else graph.addEdge(dependencies, task.id);
    for (const dependency of dependencies) dependants.get(dependency)?.push(task.id);
  }
  for (const task of plan.tasks) {
    if (dependants.get(task.id)?.length === 0) graph.addEdge(task.id, END);
  }

  const finalState = await graph.compile().invoke(
    { results: [] },
    options.signal ? { signal: options.signal } : undefined,
  );
  const order = new Map(plan.tasks.map((task, index) => [task.id, index]));
  const results = [...finalState.results].sort(
    (left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    objective: plan.objective,
    status: results.some((result) => result.status === "failed") ? "completed_with_errors" : "completed",
    results,
  };
}

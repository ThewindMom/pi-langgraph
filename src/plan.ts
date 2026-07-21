import { MAX_TASKS, TOOL_NAME, type OrchestrationPlan, type OrchestrationTask } from "./types.ts";

const taskIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class InvalidPlanError extends Error {
  readonly name = "InvalidPlanError";
}

export function validatePlan(plan: OrchestrationPlan): void {
  if (plan.objective.trim().length === 0) throw new InvalidPlanError("objective must not be empty");
  if (plan.tasks.length === 0) throw new InvalidPlanError("at least one task is required");
  if (plan.tasks.length > MAX_TASKS) throw new InvalidPlanError(`at most ${MAX_TASKS} tasks are allowed`);

  const tasks = new Map<string, OrchestrationTask>();
  for (const task of plan.tasks) {
    if (!taskIdPattern.test(task.id)) {
      throw new InvalidPlanError(`task id ${JSON.stringify(task.id)} must match ${taskIdPattern}`);
    }
    if (task.id === TOOL_NAME) throw new InvalidPlanError(`task id ${JSON.stringify(task.id)} is reserved`);
    if (tasks.has(task.id)) throw new InvalidPlanError(`duplicate task id ${JSON.stringify(task.id)}`);
    if (task.prompt.trim().length === 0) throw new InvalidPlanError(`task ${JSON.stringify(task.id)} has an empty prompt`);
    tasks.set(task.id, task);
  }

  for (const task of plan.tasks) {
    const dependencies = task.dependsOn ?? [];
    const seen = new Set<string>();
    for (const dependency of dependencies) {
      if (!tasks.has(dependency)) {
        throw new InvalidPlanError(`task ${JSON.stringify(task.id)} depends on unknown task ${JSON.stringify(dependency)}`);
      }
      if (dependency === task.id) throw new InvalidPlanError(`task ${JSON.stringify(task.id)} depends on itself`);
      if (seen.has(dependency)) {
        throw new InvalidPlanError(`task ${JSON.stringify(task.id)} repeats dependency ${JSON.stringify(dependency)}`);
      }
      seen.add(dependency);
    }
  }

  assertAcyclic(plan.tasks);
}

function assertAcyclic(tasks: readonly OrchestrationTask[]): void {
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn?.length ?? 0]));
  const dependants = new Map(tasks.map((task) => [task.id, [] as string[]]));

  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) dependants.get(dependency)?.push(task.id);
  }

  const ready = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop();
    if (id === undefined) break;
    visited += 1;
    for (const dependant of dependants.get(id) ?? []) {
      const next = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, next);
      if (next === 0) ready.push(dependant);
    }
  }

  if (visited !== tasks.length) throw new InvalidPlanError("task dependencies contain a cycle");
}

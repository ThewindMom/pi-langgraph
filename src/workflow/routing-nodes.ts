import { Send } from "@langchain/langgraph";
import { aggregateExecutionPlan } from "./compiler.ts";
import { InvalidWorkerOutputError } from "./parsers.ts";
import { interruptForChange } from "./risk-policy.ts";
import type { WorkflowStateValue } from "./workflow-state.ts";
import type { ChangeResult, WorkItem } from "./types.ts";
import { MAX_WORK_ITEMS } from "./types.ts";

export function classifyNode(state: WorkflowStateValue) {
  return {
    phase: "classified" as const,
    status: "running" as const,
    trace: [{ node: "classify" as const, iteration: state.iteration }],
  };
}

export function dispatchNode() {
  return {};
}

export function collectNode(state: WorkflowStateValue) {
  const existing = new Map(state.workItems.map((item) => [item.id, item]));
  const workItemOrder = new Map(state.workItems.map((item, index) => [item.id, index]));
  const proposals = [...state.findings]
    .sort(
      (left, right) =>
        (workItemOrder.get(left.workItemId) ?? Number.MAX_SAFE_INTEGER) -
          (workItemOrder.get(right.workItemId) ?? Number.MAX_SAFE_INTEGER) ||
        left.workItemId.localeCompare(right.workItemId),
    )
    .flatMap((finding) => finding.discoveredWorkItems);
  const additions: WorkItem[] = [];
  for (const proposal of proposals) {
    const previous = existing.get(proposal.id);
    if (previous !== undefined) {
      if (previous.title !== proposal.title || previous.instruction !== proposal.instruction) {
        throw new InvalidWorkerOutputError(`conflicting discovered work item ${JSON.stringify(proposal.id)}`);
      }
      continue;
    }
    existing.set(proposal.id, proposal);
    additions.push(proposal);
  }
  if (additions.length > 0 && state.discoveryRound >= 2) {
    throw new InvalidWorkerOutputError("replanning exceeds the 2-round discovery bound");
  }
  const remainingCapacity = Math.max(0, MAX_WORK_ITEMS - state.workItems.length);
  const selectedAdditions = additions.slice(0, remainingCapacity);
  return {
    workItems: [...state.workItems, ...selectedAdditions],
    phase: "analyzed" as const,
    ...(selectedAdditions.length === 0
      ? {}
      : {
          discoveryRound: state.discoveryRound + 1,
          trace: [{ node: "replan" as const, iteration: state.iteration }],
        }),
  };
}

export function escalateNode(state: WorkflowStateValue) {
  const failedChange = [...state.changeResults].reverse().find((result) => result.status === "needs_attention");
  if (failedChange !== undefined) {
    const risk = failedChange.verification === undefined
      ? `Planned change ${failedChange.changeId} was rejected at its approval boundary.`
      : `Planned change ${failedChange.changeId} still fails after bounded repair.`;
    return {
      summary: risk,
      unresolvedRisks: [risk],
      verification: failedChange.verification,
      phase: "escalated" as const,
      status: "needs_attention" as const,
      trace: [{ node: "escalate" as const, iteration: state.iteration }],
    };
  }
  const suffix = state.maxIterations === 1 ? "iteration" : "iterations";
  const risk = `Verification still fails after ${state.maxIterations} repair ${suffix}.`;
  return {
    summary: risk,
    unresolvedRisks: [risk],
    phase: "escalated" as const,
    status: "needs_attention" as const,
    trace: [{ node: "escalate" as const, iteration: state.iteration }],
  };
}

export function routeDispatch(state: WorkflowStateValue) {
  const completed = new Set(state.findings.map((finding) => finding.workItemId));
  const pending = state.workItems.filter((workItem) => !completed.has(workItem.id));
  if (pending.length > 0) {
    return pending.map(
      (workItem) =>
        new Send("specialist", {
          objective: state.objective,
          currentWorkItem: workItem,
          iteration: state.iteration,
          findings: [],
          trace: [],
        }),
    );
  }
  return state.pattern === "review" ? "synthesize" : "prepare_change";
}

export function createPrepareChangeNode(threadId: string) {
  return (state: WorkflowStateValue) => {
    const plan = state.plan ?? aggregateExecutionPlan({
      threadId,
      objective: state.objective,
      discovery: { workItems: state.workItems, acceptanceCriteria: state.acceptanceCriteria },
      findings: state.findings,
    });
    const results = latestResults(state.changeResults);
    const failed = plan.changes.find((change) => results.get(change.changeId)?.status === "failed");
    if (failed !== undefined) {
      const previous = results.get(failed.changeId);
      if (previous === undefined) throw new Error("failed change result is missing");
      if (previous.attempt > state.maxIterations) {
        return { plan, changeResults: [{ ...previous, status: "needs_attention" as const }] };
      }
      return selectChange(state, plan, failed.changeId, previous.attempt + 1);
    }
    const ready = plan.changes.find((change) => {
      if (results.has(change.changeId)) return false;
      return change.dependsOn.every((dependency) => results.get(dependency)?.status === "passed");
    });
    if (ready === undefined) return { plan };
    return selectChange(state, plan, ready.changeId, 1);
  };
}

export function routePreparedChange(state: WorkflowStateValue) {
  const plan = state.plan;
  if (plan === undefined) throw new Error("execution plan is missing");
  const results = latestResults(state.changeResults);
  const change = plan.changes.find((candidate) => results.get(candidate.changeId)?.status === "running");
  if (change !== undefined) {
    const current = results.get(change.changeId);
    if (current === undefined) throw new Error("selected change result is missing");
    const prior = [...state.changeResults]
      .slice(0, -1)
      .reverse()
      .find((result) => result.changeId === change.changeId);
    return new Send("change", {
      objective: state.objective,
      plan,
      change,
      current,
      previousResult: prior,
      findings: state.findings,
      hadGlobalChange: state.changes.length > 0,
      interrupt: state.interrupt,
      changes: [],
      changeResults: [],
      evidenceRefs: [],
      unresolvedRisks: [],
      phase: state.phase,
      iteration: state.iteration,
      trace: [],
      status: state.status,
    });
  }
  if (plan.changes.every((change) => results.get(change.changeId)?.status === "passed")) return "verify";
  return "escalate";
}

function selectChange(
  state: WorkflowStateValue,
  plan: NonNullable<WorkflowStateValue["plan"]>,
  changeId: string,
  attempt: number,
) {
  const change = plan.changes.find((candidate) => candidate.changeId === changeId);
  if (change === undefined) throw new Error("selected planned change is missing");
  const pendingInterrupt = interruptForChange(plan, change, attempt, state.approvalRequired);
  const result: ChangeResult = { changeId, status: "running", attempt, evidenceRefs: [] };
  return {
    plan,
    changeResults: [result],
    interrupt: pendingInterrupt,
    status: pendingInterrupt === undefined ? "running" as const : "awaiting_approval" as const,
    ...(pendingInterrupt === undefined ? {} : { phase: "analyzed" as const }),
  };
}

function latestResults(results: readonly ChangeResult[]): ReadonlyMap<string, ChangeResult> {
  return new Map(results.map((result) => [result.changeId, result]));
}

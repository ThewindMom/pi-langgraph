import { Send } from "@langchain/langgraph";
import { InvalidWorkerOutputError } from "./parsers.ts";
import type { WorkflowStateValue } from "./workflow-state.ts";
import type { WorkItem } from "./types.ts";
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
  return state.pattern === "review" ? "synthesize" : "implement";
}

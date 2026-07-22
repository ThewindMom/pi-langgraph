import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import type { WorkflowStateValue } from "./graph.ts";
import type {
  ApprovalRequiredResult,
  CodingRunResult,
  CodingWorkflowResult,
  WorkflowPhase,
  WorkflowTraceEvent,
  ScopedInterrupt,
} from "./types.ts";
import { isAggregatePlan } from "./compiler.ts";
import { parseScopedInterrupt } from "./risk-policy.ts";

export interface WorkflowHistoryEntry {
  readonly checkpointId: string;
  readonly parentCheckpointId?: string;
  readonly step?: number;
  readonly phase?: WorkflowPhase;
  readonly trace: readonly WorkflowTraceEvent[];
}

export function projectHistoryEntry(tuple: CheckpointTuple): WorkflowHistoryEntry | undefined {
  const checkpointId = tuple.config.configurable?.checkpoint_id;
  if (typeof checkpointId !== "string") return undefined;
  const parentCheckpointId = tuple.parentConfig?.configurable?.checkpoint_id;
  const phase = phaseValue(tuple.checkpoint.channel_values.phase);
  return {
    checkpointId,
    ...(typeof parentCheckpointId === "string" ? { parentCheckpointId } : {}),
    ...(typeof tuple.metadata?.step === "number" ? { step: tuple.metadata.step } : {}),
    ...(phase === undefined ? {} : { phase }),
    trace: traceValue(tuple.checkpoint.channel_values.trace),
  };
}

export function projectResult(threadId: string, state: WorkflowStateValue): CodingRunResult {
  if (state.status === "awaiting_approval") return projectApproval(threadId, state);
  if (state.status !== "completed" && state.status !== "needs_attention") {
    throw new Error(`workflow reached unsupported terminal status ${JSON.stringify(state.status)}`);
  }
  if (state.pattern === "delivery" && state.status === "completed" && state.verification?.passed !== true) {
    throw new Error("mutating workflow reached completion without passing verification");
  }
  const order = new Map(state.workItems.map((item, index) => [item.id, index]));
  const findings = [...state.findings].sort(
    (left, right) =>
      (order.get(left.workItemId) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(right.workItemId) ?? Number.MAX_SAFE_INTEGER),
  );
  const changes = state.plan !== undefined && !isAggregatePlan(state.plan)
    ? state.changeResults.flatMap((result) => result.change === undefined ? [] : [result.change])
    : state.changes;
  const unresolvedRisks = unique([
    ...state.unresolvedRisks,
    ...(state.pattern === "review" ? state.findings.flatMap((finding) => finding.risks) : []),
    ...changes.flatMap((change) => change.unresolvedRisks),
  ]);
  const result: CodingWorkflowResult = {
    threadId,
    objective: state.objective,
    pattern: state.pattern,
    status: state.status,
    phase: state.phase,
    workItems: state.workItems,
    findings,
    changes,
    ...(state.verification === undefined ? {} : { verification: state.verification }),
    unresolvedRisks,
    iteration: state.iteration,
    summary: state.summary,
    trace: state.trace,
    ...(state.plan === undefined ? {} : { plan: state.plan }),
    changeResults: state.changeResults,
    evidenceRefs: state.evidenceRefs,
  };
  return result;
}

export function projectApproval(
  threadId: string,
  state: WorkflowStateValue | Readonly<Record<string, unknown>>,
): ApprovalRequiredResult {
  const objective = state.objective;
  const pattern = state.pattern;
  const phase = state.phase;
  const pendingInterrupt = interruptValue(state.interrupt);
  if (typeof objective !== "string" || (pattern !== "delivery" && pattern !== "review") || phase !== "analyzed") {
    throw new Error("workflow paused outside the supported approval boundary");
  }
  return {
    threadId,
    objective,
    pattern,
    status: "awaiting_approval",
    phase,
    workItems: workItemsValue(state.workItems),
    findings: findingsValue(state.findings),
    trace: traceValue(state.trace),
    interrupt: pendingInterrupt,
  };
}

export function phaseValue(value: unknown): WorkflowPhase | undefined {
  if (
    value === "classified" || value === "discovered" || value === "analyzed" || value === "implemented" ||
    value === "verified" || value === "diagnosed" || value === "repaired" || value === "synthesized" ||
    value === "escalated"
  ) return value;
  return undefined;
}

export function workItemsValue(value: unknown): ApprovalRequiredResult["workItems"] {
  if (!Array.isArray(value)) throw new Error("checkpoint workItems are invalid");
  return value.filter(isWorkItem);
}
export function findingsValue(value: unknown): ApprovalRequiredResult["findings"] {
  if (!Array.isArray(value)) throw new Error("checkpoint findings are invalid");
  return value.filter(isFinding);
}
export function traceValue(value: unknown): readonly WorkflowTraceEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isTraceEvent);
}
export function interruptValue(value: unknown): ScopedInterrupt {
  return parseScopedInterrupt(value);
}
export function isWorkItem(value: unknown): value is ApprovalRequiredResult["workItems"][number] {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.instruction === "string";
}
export function isFinding(value: unknown): value is ApprovalRequiredResult["findings"][number] {
  return isRecord(value) && typeof value.workItemId === "string" && typeof value.summary === "string" && Array.isArray(value.evidence) && Array.isArray(value.risks);
}
export function isTraceEvent(value: unknown): value is WorkflowTraceEvent {
  return isRecord(value) && typeof value.node === "string" && typeof value.iteration === "number";
}
export function unique(values: readonly string[]): readonly string[] { return [...new Set(values)]; }
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

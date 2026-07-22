import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { workflowRecursionLimit } from "./compiler.ts";
import type { WorkflowPhase } from "./types.ts";

export const leases = new Map<string, Promise<void>>();

export interface DurableInvocationConfig extends LangGraphRunnableConfig {
  readonly durability: "sync";
}

export function invocationConfig(
  threadId: string,
  recursionLimit: number,
  signal: AbortSignal | undefined,
): DurableInvocationConfig {
  return {
    configurable: { thread_id: threadId },
    recursionLimit,
    durability: "sync",
    ...(signal === undefined ? {} : { signal }),
  };
}

export function readSavedControlState(tuple: CheckpointTuple): {
  readonly recursionLimit: number;
  readonly approvalRequired: boolean;
  readonly phase: WorkflowPhase;
} {
  const values = tuple.checkpoint.channel_values;
  const maxIterations = values.maxIterations;
  const approvalRequired = values.approvalRequired;
  const phase = phaseValue(values.phase);
  if (
    typeof maxIterations !== "number" ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 0 ||
    maxIterations > 5 ||
    typeof approvalRequired !== "boolean" ||
    phase === undefined
  ) {
    throw new Error("checkpoint contains invalid workflow control state");
  }
  return { recursionLimit: workflowRecursionLimit(maxIterations), approvalRequired, phase };
}

function phaseValue(value: unknown): WorkflowPhase | undefined {
  if (
    value === "classified" ||
    value === "discovered" ||
    value === "analyzed" ||
    value === "implemented" ||
    value === "verified" ||
    value === "diagnosed" ||
    value === "repaired" ||
    value === "synthesized" ||
    value === "escalated"
  ) {
    return value;
  }
  return undefined;
}

export async function withThreadLease<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
  const previous = leases.get(threadId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  leases.set(threadId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (leases.get(threadId) === tail) leases.delete(threadId);
  }
}

export function validateThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(threadId)) {
    throw new Error("threadId must be a 1-128 character lexical identifier");
  }
}

import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { workflowRecursionLimit } from "./compiler.ts";
import type { WorkflowPhase } from "./types.ts";

export const leases = new Map<string, Promise<void>>();

export interface DurableInvocationConfig extends LangGraphRunnableConfig {
  readonly durability: "sync";
}

export interface WorkflowStreamConfig extends DurableInvocationConfig {
  readonly streamMode: ("updates" | "custom" | "tasks" | "checkpoints")[];
  readonly subgraphs: true;
}

export type InvocationIdentity = {
  readonly threadId: string;
  readonly runId: string;
};

export function invocationConfig(
  identity: InvocationIdentity,
  recursionLimit: number,
  signal: AbortSignal | undefined,
): DurableInvocationConfig {
  return {
    configurable: { thread_id: identity.threadId },
    runId: identity.runId,
    recursionLimit,
    durability: "sync",
    ...(signal === undefined ? {} : { signal }),
  };
}

export function streamInvocationConfig(
  identity: InvocationIdentity,
  recursionLimit: number,
  signal: AbortSignal | undefined,
): WorkflowStreamConfig {
  return {
    ...invocationConfig(identity, recursionLimit, signal),
    streamMode: ["updates", "custom", "tasks", "checkpoints"],
    subgraphs: true,
  };
}

export function readSavedControlState(tuple: CheckpointTuple): {
  readonly recursionLimit: number;
  readonly approvalRequired: boolean;
  readonly phase: WorkflowPhase;
} {
  const maxIterations = checkpointChannelValue(tuple, "maxIterations");
  const approvalRequired = checkpointChannelValue(tuple, "approvalRequired");
  const phase = phaseValue(checkpointChannelValue(tuple, "phase"));
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

export function checkpointChannelValue(tuple: CheckpointTuple, channel: string): unknown {
  const pending = tuple.pendingWrites?.findLast((write) => write[1] === channel);
  return pending?.[2] ?? tuple.checkpoint.channel_values[channel];
}

export function hasPendingGraphInterrupt(tuple: CheckpointTuple): boolean {
  return tuple.pendingWrites?.some(([, channel]) => channel === "__interrupt__") ?? false;
}

export function pendingGraphInterruptValue(tuple: CheckpointTuple): unknown {
  const pending = tuple.pendingWrites?.findLast(([, channel]) => channel === "__interrupt__");
  const interrupt = pending?.[2];
  return isRecord(interrupt) ? interrupt.value : undefined;
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

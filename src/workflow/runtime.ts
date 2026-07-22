import { randomUUID } from "node:crypto";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { TaskExecutor } from "../types.ts";
import { compileWorkflow } from "./compiler.ts";
import { compileCodingGraph } from "./graph.ts";
import {
  projectApproval,
  projectHistoryEntry,
  projectResult,
  type WorkflowHistoryEntry,
} from "./result-projection.ts";
import { invocationConfig, readSavedControlState, validateThreadId, withThreadLease } from "./runtime-control.ts";
import type { CodingRunOptions, CodingRunResult, CodingWorkflowInput, ResumeRunOptions } from "./types.ts";

export type { WorkflowHistoryEntry } from "./result-projection.ts";

const DEFAULT_NODE_TIMEOUT_MS = 10 * 60 * 1_000;

export async function runCodingWorkflow(
  input: CodingWorkflowInput,
  executor: TaskExecutor,
  options: CodingRunOptions = {},
): Promise<CodingRunResult> {
  const compiled = compileWorkflow(input);
  const threadId = options.threadId ?? randomUUID();
  validateThreadId(threadId);
  const checkpointer = options.checkpointer ?? new MemorySaver();
  const approvalRequired =
    compiled.pattern === "delivery" && (options.requireApproval === true || input.approval === "before_changes");

  return withThreadLease(threadId, async () => {
    const graph = compileCodingGraph(
      {
        executor,
        nodeTimeoutMs: options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      },
      { checkpointer, interruptBeforeMutation: approvalRequired },
    );
    const state = await graph.invoke(
      {
        objective: compiled.objective,
        pattern: compiled.pattern,
        maxIterations: compiled.maxIterations,
        approvalRequired,
        discoveryRound: 0,
        workItems: [],
        acceptanceCriteria: [],
        findings: [],
        changes: [],
        iteration: 0,
        phase: "classified",
        status: "running",
        summary: "",
        unresolvedRisks: [],
        trace: [],
      },
      invocationConfig(threadId, compiled.recursionLimit, options.signal),
    );
    const result = projectResult(threadId, state);
    if (result.status === "completed" && options.retainCheckpoint !== true) await checkpointer.deleteThread(threadId);
    return result;
  });
}

export async function resumeCodingWorkflow(
  threadId: string,
  executor: TaskExecutor,
  options: ResumeRunOptions,
): Promise<CodingRunResult> {
  validateThreadId(threadId);
  const checkpointer = options.checkpointer;
  if (checkpointer === undefined) throw new Error("resume requires the checkpointer that owns the thread");

  return withThreadLease(threadId, async () => {
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
    if (tuple === undefined) throw new Error(`no checkpoint exists for thread ${JSON.stringify(threadId)}`);
    const saved = readSavedControlState(tuple);
    if (saved.approvalRequired && saved.phase === "analyzed" && options.approved !== true) {
      return projectApproval(threadId, tuple.checkpoint.channel_values);
    }
    const graph = compileCodingGraph(
      {
        executor,
        nodeTimeoutMs: options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      },
      { checkpointer, interruptBeforeMutation: false },
    );
    const state = await graph.invoke(null, invocationConfig(threadId, saved.recursionLimit, options.signal));
    const result = projectResult(threadId, state);
    if (result.status === "completed" && options.retainCheckpoint !== true) await checkpointer.deleteThread(threadId);
    return result;
  });
}

export async function getWorkflowHistory(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<readonly WorkflowHistoryEntry[]> {
  validateThreadId(threadId);
  const history: WorkflowHistoryEntry[] = [];
  for await (const tuple of checkpointer.list({ configurable: { thread_id: threadId } })) {
    const entry = projectHistoryEntry(tuple);
    if (entry !== undefined) history.push(entry);
  }
  return history;
}

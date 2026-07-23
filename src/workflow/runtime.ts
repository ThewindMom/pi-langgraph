import { randomUUID } from "node:crypto";
import { Command } from "@langchain/langgraph";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { TaskExecutor } from "../types.ts";
import { deleteMutationJournalThread, mutationJournalFor } from "../persistence/mutation-journal.ts";
import { compileWorkflow } from "./compiler.ts";
import { compileCodingGraph, type WorkflowStateValue } from "./graph.ts";
import {
  projectApproval,
  projectHistoryEntry,
  projectResult,
  interruptValue,
  type WorkflowHistoryEntry,
} from "./result-projection.ts";
import {
  checkpointChannelValue,
  hasPendingGraphInterrupt,
  pendingGraphInterruptValue,
  readSavedControlState,
  streamInvocationConfig,
  validateThreadId,
  withThreadLease,
} from "./runtime-control.ts";
import type { CodingRunOptions, CodingRunResult, CodingWorkflowInput, ResumeRunOptions } from "./types.ts";
import { assertDecisionScope, decisionForInterrupt, parseInterruptDecision } from "./risk-policy.ts";
import { projectStreamEvents, terminalEvent } from "./stream-events.ts";
import { WorkflowState } from "./workflow-state.ts";

export type { WorkflowHistoryEntry } from "./result-projection.ts";

export interface WorkflowThreadStore {
  listThreads(): Promise<readonly string[]>;
}

export class NoPendingApprovalError extends Error {
  readonly name = "NoPendingApprovalError";
}

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
        ...(options.evidenceRunner === undefined ? {} : { evidenceRunner: options.evidenceRunner }),
      },
      {
        checkpointer,
        mutationJournal: mutationJournalFor(checkpointer),
        threadId,
      },
    );
    const runId = randomUUID();
    const config = streamInvocationConfig({ threadId, runId }, compiled.recursionLimit, options.signal);
    let sequence = 0;
    for await (const chunk of await graph.stream(
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
        changeResults: [],
        evidenceRefs: [],
      },
      config,
    )) {
      const events = projectStreamEvents({ runId, threadId, sequence }, chunk);
      for (const event of events) {
        options.onEvent?.(event);
      }
      sequence += events.length;
    }
    const state = (await graph.getState(config)).values;
    const result = await projectLatestResult(checkpointer, threadId, state);
    options.onEvent?.(terminalEvent(
      { runId, threadId, sequence },
      result.status,
      "evidenceRefs" in result ? result.evidenceRefs : [],
    ));
    if (result.status === "completed" && options.retainCheckpoint !== true) {
      await checkpointer.deleteThread(threadId);
      await deleteMutationJournalThread(checkpointer, threadId);
    }
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
    const tuple = await checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        ...(options.checkpointId === undefined ? {} : { checkpoint_id: options.checkpointId }),
      },
    });
    if (tuple === undefined) throw new Error(`no checkpoint exists for thread ${JSON.stringify(threadId)}`);
    if (options.checkpointId !== undefined) {
      const latest = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
      if (tuple.checkpoint.id !== options.checkpointId || latest?.checkpoint.id !== options.checkpointId) {
        throw new ResumeCheckpointSelectionError(options.checkpointId);
      }
    }
    const saved = readSavedControlState(tuple);
    const savedStatus = checkpointChannelValue(tuple, "status");
    const pendingInterrupt = savedStatus === "awaiting_approval" && hasPendingGraphInterrupt(tuple)
      ? interruptValue(pendingGraphInterruptValue(tuple))
      : undefined;
    const submittedDecision = options.decision === undefined ? undefined : parseInterruptDecision(options.decision);
    const decision = submittedDecision ?? (
      options.approved === true && pendingInterrupt !== undefined
        ? decisionForInterrupt(pendingInterrupt, "approve")
        : undefined
    );
    if (pendingInterrupt === undefined && (submittedDecision !== undefined || options.approved === true)) {
      throw new NoPendingApprovalError("workflow has no pending approval");
    }
    if (pendingInterrupt !== undefined && decision === undefined) {
      return projectApproval(threadId, {
        ...tuple.checkpoint.channel_values,
        phase: saved.phase,
        status: savedStatus,
        interrupt: pendingInterrupt,
      });
    }
    if (pendingInterrupt !== undefined && decision !== undefined) assertDecisionScope(decision, pendingInterrupt);
    const graph = compileCodingGraph(
      {
        executor,
        nodeTimeoutMs: options.nodeTimeoutMs ?? DEFAULT_NODE_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
        ...(options.evidenceRunner === undefined ? {} : { evidenceRunner: options.evidenceRunner }),
      },
      {
        checkpointer,
        mutationJournal: mutationJournalFor(checkpointer),
        threadId,
      },
    );
    const runId = randomUUID();
    const latestConfig = streamInvocationConfig({ threadId, runId }, saved.recursionLimit, options.signal);
    const config = options.checkpointId === undefined
      ? latestConfig
      : {
        ...latestConfig,
        configurable: {
          ...latestConfig.configurable,
          checkpoint_id: options.checkpointId,
        },
      };
    let sequence = 0;
    const input = decision === undefined
      ? null
      : new Command<unknown, typeof WorkflowState.Update, never>({ resume: decision });
    for await (const chunk of await graph.stream(input, config)) {
      const events = projectStreamEvents({ runId, threadId, sequence }, chunk);
      for (const event of events) {
        options.onEvent?.(event);
      }
      sequence += events.length;
    }
    const state = (await graph.getState(latestConfig)).values;
    const result = await projectLatestResult(checkpointer, threadId, state);
    options.onEvent?.(terminalEvent(
      { runId, threadId, sequence },
      result.status,
      "evidenceRefs" in result ? result.evidenceRefs : [],
    ));
    if (result.status === "completed" && options.retainCheckpoint !== true) {
      await checkpointer.deleteThread(threadId);
      await deleteMutationJournalThread(checkpointer, threadId);
    }
    return result;
  });
}

export class ResumeCheckpointSelectionError extends Error {
  readonly name = "ResumeCheckpointSelectionError";

  constructor(readonly checkpointId: string) {
    super(`checkpoint is no longer the latest resumable checkpoint: ${checkpointId}`);
  }
}

async function projectLatestResult(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
  state: WorkflowStateValue,
): Promise<CodingRunResult> {
  if (state.status !== "awaiting_approval") return projectResult(threadId, state);
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: threadId } });
  if (tuple === undefined || !hasPendingGraphInterrupt(tuple)) {
    throw new Error("workflow awaiting approval has no resumable graph interrupt");
  }
  return projectApproval(threadId, { ...state, interrupt: pendingGraphInterruptValue(tuple) });
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

export function listWorkflowThreads(checkpointer: WorkflowThreadStore): Promise<readonly string[]> {
  return checkpointer.listThreads();
}

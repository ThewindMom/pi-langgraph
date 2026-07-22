import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { createRepositoryExecutionPolicy, createTaskExecutor } from "./executors.ts";
import { runOrchestration } from "./graph.ts";
import { FileCheckpointSaver } from "./persistence/file-checkpoint-saver.ts";
import { orchestrationSchema, type OrchestrationInput } from "./runtime/public-contract.ts";
import { RepositoryServices } from "./runtime/repository-services.ts";
import { forkWorkflowCheckpoint } from "./workflow/forks.ts";
import { getWorkflowHistory, listWorkflowThreads, resumeCodingWorkflow, runCodingWorkflow } from "./workflow/runtime.ts";
import { WorktreeManager, type ForkManifest } from "./workspace/worktree-manager.ts";
import {
  DEFAULT_AGENT_TOOL,
  TOOL_NAME,
  type LangGraphExtensionAPI,
  type OrchestrationDetails,
} from "./types.ts";
import type { CodingRunOptions, CodingRunResult } from "./workflow/types.ts";

type PublicActionDetails =
  | { readonly action: "list"; readonly threadIds: readonly string[] }
  | { readonly action: "history"; readonly threadId: string; readonly history: Awaited<ReturnType<typeof getWorkflowHistory>> }
  | { readonly action: "fork"; readonly manifest: ForkManifest };
type ExtensionDetails = OrchestrationDetails | CodingRunResult | PublicActionDetails;

export default function langGraphExtension(pi: LangGraphExtensionAPI): void {
  const dataRoot = join(getAgentDir(), "extensions", "pi-langgraph", "data");
  let saverPromise: Promise<FileCheckpointSaver> | undefined;
  let worktreePromise: Promise<WorktreeManager> | undefined;
  const durableSaver = () => {
    saverPromise ??= FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
    return saverPromise;
  };
  const worktrees = () => {
    worktreePromise ??= WorktreeManager.open(join(dataRoot, "forks"));
    return worktreePromise;
  };

  pi.registerTool<typeof orchestrationSchema, ExtensionDetails>({
    name: TOOL_NAME,
    label: "LangGraph Coding Workflow",
    description:
      "Compile a normal software objective into a safe coding workflow with dynamic repository analysis, serialized implementation, executable verification, bounded repair, durable resume, and evidence-based synthesis. Raw nodes and edges are intentionally not accepted. A legacy tasks DAG remains available for migration.",
    promptSnippet: "Run durable, verified coding workflows through trusted LangGraph patterns",
    promptGuidelines: [
      `Silently classify substantive repository work. Call ${TOOL_NAME} with only the normal objective when the work benefits from repository discovery, multi-area analysis, implementation plus verification, or review synthesis. The extension owns graph topology and bounds.`,
      `Use workflow "review" for read-only audits and "delivery" for code changes. Use "auto" when unclear. Request approval "before_changes" for unusually risky mutation.`,
      `If an earlier ${TOOL_NAME} run returned awaiting_approval, stop and show it to the user. Resume only after a new user message, using resumeThreadId plus the exact structured decision bound to that interrupt. Never infer or self-submit approval.`,
      `After any terminal result, return that result to the user. Treat findings as evidence, not authorization: never start a follow-up workflow unless the user explicitly requested that additional work.`,
      `Use the legacy tasks array only for compatibility with an existing explicit DAG; never invent raw graph nodes, edges, cycles, or routing policy for the autonomous workflow.`,
    ],
    parameters: orchestrationSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: OrchestrationInput, signal, onUpdate, context) {
      const usesNativeTaskTool =
        pi.executeTool !== undefined && pi.getActiveTools().includes(DEFAULT_AGENT_TOOL);
      const repositoryPolicy = createRepositoryExecutionPolicy(pi, context);

      if ("tasks" in params) {
        const result = await runOrchestration(params, createTaskExecutor(pi, context), {
          ...(signal === undefined ? {} : { signal }),
          ...(onUpdate === undefined
            ? {}
            : {
                onProgress: (progress) => {
                  onUpdate({
                    content: [{ type: "text", text: renderProgress(progress) }],
                    details: { objective: params.objective, status: "running", progress },
                  });
                },
              }),
        });
        return resultEnvelope(result, usesNativeTaskTool);
      }

      const checkpointer = await durableSaver();
      if ("action" in params) {
        switch (params.action) {
          case "list":
            return actionEnvelope("Workflow threads listed.", { action: "list", threadIds: await listWorkflowThreads(checkpointer) });
          case "history":
            return actionEnvelope("Workflow history loaded.", {
              action: "history",
              threadId: params.threadId,
              history: await getWorkflowHistory(checkpointer, params.threadId),
            });
          case "fork": {
            const manager = await worktrees();
            const sourceFork = await manager.getFork(params.sourceThreadId);
            const sourceCwd = sourceFork?.workspacePath ?? context.cwd;
            const services = await RepositoryServices.open(dataRoot, sourceCwd, {
              executor: createTaskExecutor(pi, { ...context, cwd: sourceCwd }),
              policy: createRepositoryExecutionPolicy(pi, { ...context, cwd: sourceCwd }),
            });
            const manifest = await forkWorkflowCheckpoint({
              checkpointer,
              worktreeManager: manager,
              sourceCwd,
              sourceThreadId: params.sourceThreadId,
              checkpointId: params.checkpointId,
              gitCommit: params.gitCommit,
              forkThreadId: params.forkThreadId,
              retainArtifacts: (forkThreadId, refs) => services.retainFork(forkThreadId, refs),
            });
            return actionEnvelope(`Workflow fork ${params.forkThreadId} created.`, { action: "fork", manifest });
          }
        }
      }

      if ("resumeThreadId" in params) {
        const fork = await (await worktrees()).getFork(params.resumeThreadId);
        const cwd = fork?.workspacePath ?? context.cwd;
        const services = await RepositoryServices.open(dataRoot, cwd, {
          executor: createTaskExecutor(pi, { ...context, cwd }),
          policy: createRepositoryExecutionPolicy(pi, { ...context, cwd }),
          threadId: params.resumeThreadId,
        });
        services.bindCheckpoint(checkpointer, params.resumeThreadId);
        const result = await resumeCodingWorkflow(params.resumeThreadId, services.executor, {
          checkpointer,
          retainCheckpoint: true,
          evidenceRunner: services.evidenceRunner,
          ...(params.decision === undefined ? {} : { decision: params.decision }),
          ...(signal === undefined ? {} : { signal }),
          ...workflowCallbacks(onUpdate, "resumed workflow"),
        });
        await recordResult(checkpointer, services, result);
        return workflowEnvelope(result, usesNativeTaskTool);
      }

      const threadId = params.threadId ?? randomUUID();
      const services = await RepositoryServices.open(dataRoot, context.cwd, {
        executor: createTaskExecutor(pi, context),
        policy: repositoryPolicy,
        threadId,
      });
      services.bindCheckpoint(checkpointer, threadId);
      onUpdate?.({
        content: [{ type: "text", text: `workflow: started (thread ${threadId})` }],
        details: {
          objective: params.objective,
          status: "running",
          progress: { taskId: threadId, status: "started", completed: 0, total: 1 },
        },
      });
      const result = await runCodingWorkflow(
        {
          objective: params.objective,
          ...(params.workflow === undefined ? {} : { workflow: params.workflow }),
          ...(params.maxIterations === undefined ? {} : { maxIterations: params.maxIterations }),
          ...(params.approval === undefined ? {} : { approval: params.approval }),
        },
        services.executor,
        {
          checkpointer,
          threadId,
          retainCheckpoint: true,
          evidenceRunner: services.evidenceRunner,
          ...(signal === undefined ? {} : { signal }),
          ...workflowCallbacks(onUpdate, params.objective),
        },
      );
      await recordResult(checkpointer, services, result);
      return workflowEnvelope(result, usesNativeTaskTool);
    },
  });
}

function workflowCallbacks(
  onUpdate: AgentToolUpdateCallback<ExtensionDetails> | undefined,
  objective: string,
): Pick<CodingRunOptions, "onProgress" | "onEvent"> {
  if (onUpdate === undefined) return {};
  return {
    onProgress: (progress) => {
      onUpdate({ content: [{ type: "text", text: renderProgress(progress) }], details: { objective, status: "running", progress } });
    },
    onEvent: (event) => {
      const progress = {
        taskId: `${event.namespace}:${event.kind}`,
        status: event.kind === "terminal" ? "completed" as const : "started" as const,
        completed: event.kind === "terminal" ? 1 : 0,
        total: 1,
      };
      onUpdate({
        content: [{ type: "text", text: `workflow-event:${JSON.stringify(event)}` }],
        details: { objective, status: "running", progress },
      });
    },
  };
}

async function recordResult(
  checkpointer: FileCheckpointSaver,
  services: RepositoryServices,
  result: CodingRunResult,
): Promise<void> {
  const tuple = await checkpointer.getTuple({ configurable: { thread_id: result.threadId } });
  if (tuple === undefined) throw new Error(`completed workflow checkpoint is missing: ${result.threadId}`);
  await services.recordResult(result, tuple.checkpoint.id, tuple);
}

function actionEnvelope(text: string, details: PublicActionDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function renderProgress(progress: { readonly taskId: string; readonly status: string; readonly completed: number; readonly total: number }): string {
  return `${progress.taskId}: ${progress.status} (${progress.completed}/${progress.total})`;
}

function resultEnvelope(result: Awaited<ReturnType<typeof runOrchestration>>, native: boolean) {
  const completed = result.results.filter((task) => task.status === "completed").length;
  const failed = result.results.length - completed;
  const worker = native ? `native ${DEFAULT_AGENT_TOOL} tool` : "Pi SDK session";
  return {
    content: [
      {
        type: "text" as const,
        text: `LangGraph completed ${completed}/${result.results.length} legacy tasks via ${worker}${failed ? `; ${failed} failed` : ""}.\n\n${JSON.stringify(result, null, 2)}`,
      },
    ],
    details: result,
  };
}

function workflowEnvelope(result: CodingRunResult, native: boolean) {
  const worker = native ? `native ${DEFAULT_AGENT_TOOL} tool` : "Pi SDK session";
  if (result.status === "awaiting_approval") {
    return {
      content: [
        {
          type: "text" as const,
          text: `LangGraph analyzed ${result.workItems.length} work units via ${worker} and paused before mutation. Show the scoped interrupt to the user; resume only from a later user decision with its exact binding.`,
        },
      ],
      details: result,
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: `${result.summary}\n\nWorkflow ${result.status} via ${worker}; ${result.findings.length} findings, ${result.changes.length} change sets, ${result.verification?.checks.length ?? 0} verification checks.`,
      },
    ],
    details: result,
  };
}

export { buildTaskPrompt, resultText } from "./executors.ts";
export { runOrchestration } from "./graph.ts";
export { FileCheckpointSaver } from "./persistence/file-checkpoint-saver.ts";
export { InvalidPlanError, validatePlan } from "./plan.ts";
export { RepositoryServices } from "./runtime/repository-services.ts";
export { InvalidWorkflowError, compileWorkflow, parseWorkflowInput } from "./workflow/compiler.ts";
export { forkWorkflowCheckpoint, WorkflowForkError } from "./workflow/forks.ts";
export { getWorkflowHistory, listWorkflowThreads, resumeCodingWorkflow, runCodingWorkflow } from "./workflow/runtime.ts";
export { WorktreeManager, WorktreeManagerError } from "./workspace/worktree-manager.ts";
export type * from "./types.ts";
export type * from "./workflow/types.ts";

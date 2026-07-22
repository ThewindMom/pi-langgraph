import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createTaskExecutor } from "./executors.ts";
import { runOrchestration } from "./graph.ts";
import { FileCheckpointSaver } from "./persistence/file-checkpoint-saver.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "./workflow/runtime.ts";
import {
  DEFAULT_AGENT_TOOL,
  MAX_TASKS,
  TOOL_NAME,
  type LangGraphExtensionAPI,
  type OrchestrationDetails,
} from "./types.ts";
import type { CodingRunResult } from "./workflow/types.ts";

const taskSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
    prompt: Type.String({ minLength: 1 }),
    dependsOn: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })),
    agent: Type.Optional(Type.String({ minLength: 1 })),
    model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const legacySchema = Type.Object(
  {
    objective: Type.String({ minLength: 1 }),
    tasks: Type.Array(taskSchema, { minItems: 1, maxItems: MAX_TASKS }),
    failurePolicy: Type.Optional(Type.Union([Type.Literal("fail-fast"), Type.Literal("continue")])),
  },
  { additionalProperties: false },
);

const codingWorkflowSchema = Type.Object(
  {
    objective: Type.String({
      minLength: 1,
      maxLength: 12_000,
      description: "Normal software objective. The extension compiles the graph; do not provide nodes or edges.",
    }),
    workflow: Type.Optional(
      Type.Union([Type.Literal("auto"), Type.Literal("delivery"), Type.Literal("review")], {
        default: "auto",
      }),
    ),
    maxIterations: Type.Optional(Type.Integer({ minimum: 0, maximum: 5, default: 2 })),
    approval: Type.Optional(
      Type.Union([Type.Literal("none"), Type.Literal("before_changes")], { default: "none" }),
    ),
    threadId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" }),
    ),
  },
  { additionalProperties: false },
);

const resumeSchema = Type.Object(
  {
    resumeThreadId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      description: "A previously interrupted or approval-paused workflow thread.",
    }),
    approved: Type.Optional(
      Type.Boolean({ description: "Must be true to cross a requested before-changes approval boundary." }),
    ),
  },
  { additionalProperties: false },
);

const orchestrationSchema = Type.Union([codingWorkflowSchema, resumeSchema, legacySchema]);
type OrchestrationInput = Static<typeof orchestrationSchema>;
type ExtensionDetails = OrchestrationDetails | CodingRunResult;

export default function langGraphExtension(pi: LangGraphExtensionAPI): void {
  let saverPromise: Promise<FileCheckpointSaver> | undefined;
  const durableSaver = () => {
    saverPromise ??= FileCheckpointSaver.open(join(getAgentDir(), "extensions", "pi-langgraph", "data", "checkpoints"));
    return saverPromise;
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
      `If an earlier ${TOOL_NAME} run was interrupted or returned awaiting_approval, resume its exact thread with resumeThreadId; set approved true only after the user has approved mutation.`,
      `After any terminal result, return that result to the user. Treat findings as evidence, not authorization: never start a follow-up workflow unless the user explicitly requested that additional work.`,
      `Use the legacy tasks array only for compatibility with an existing explicit DAG; never invent raw graph nodes, edges, cycles, or routing policy for the autonomous workflow.`,
    ],
    parameters: orchestrationSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: OrchestrationInput, signal, onUpdate, context) {
      const usesNativeTaskTool =
        pi.executeTool !== undefined && pi.getActiveTools().includes(DEFAULT_AGENT_TOOL);
      const executor = createTaskExecutor(pi, context);

      if ("tasks" in params) {
        const result = await runOrchestration(params, executor, {
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
      if ("resumeThreadId" in params) {
        const result = await resumeCodingWorkflow(params.resumeThreadId, executor, {
          checkpointer,
          ...(params.approved === undefined ? {} : { approved: params.approved }),
          ...(signal === undefined ? {} : { signal }),
          ...(onUpdate === undefined
            ? {}
            : {
                onProgress: (progress) => {
                  onUpdate({ content: [{ type: "text", text: renderProgress(progress) }], details: resultDetails(progress) });
                },
              }),
        });
        return workflowEnvelope(result, usesNativeTaskTool);
      }

      const threadId = params.threadId ?? randomUUID();
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
        executor,
        {
          checkpointer,
          threadId,
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
        },
      );
      return workflowEnvelope(result, usesNativeTaskTool);
    },
  });
}

function resultDetails(progress: {
  readonly taskId: string;
  readonly status: "started" | "completed" | "failed";
  readonly completed: number;
  readonly total: number;
  readonly message?: string;
}): OrchestrationDetails {
  return { objective: "resumed workflow", status: "running", progress };
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
          text: `LangGraph analyzed ${result.workItems.length} work units via ${worker} and paused before mutation. Resume thread ${result.threadId} with approved=true after user approval.`,
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
export { InvalidWorkflowError, compileWorkflow, parseWorkflowInput } from "./workflow/compiler.ts";
export { getWorkflowHistory, resumeCodingWorkflow, runCodingWorkflow } from "./workflow/runtime.ts";
export type * from "./types.ts";
export type * from "./workflow/types.ts";

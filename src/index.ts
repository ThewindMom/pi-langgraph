import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { createTaskExecutor } from "./executors.ts";
import { runOrchestration } from "./graph.ts";
import {
  DEFAULT_AGENT_TOOL,
  MAX_TASKS,
  TOOL_NAME,
  type CompatibleExtensionAPI,
  type OrchestrationDetails,
} from "./types.ts";

const taskSchema = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 64,
      pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$",
      description: "Stable task id used by dependency edges",
    }),
    prompt: Type.String({ minLength: 1, description: "Self-contained work assigned to this Pi worker" }),
    dependsOn: Type.Optional(
      Type.Array(Type.String(), {
        uniqueItems: true,
        description: "Task ids that must finish before this task starts",
      }),
    ),
    agent: Type.Optional(Type.String({ minLength: 1, description: "Optional native Pi/Senpi agent type" })),
    model: Type.Optional(Type.String({ minLength: 1, description: "Optional model override understood by the host" })),
  },
  { additionalProperties: false },
);

const orchestrationSchema = Type.Object(
  {
    objective: Type.String({ minLength: 1, description: "Overall objective shared with every task" }),
    tasks: Type.Array(taskSchema, {
      minItems: 1,
      maxItems: MAX_TASKS,
      description: "DAG tasks. Independent tasks run concurrently; dependency edges form joins.",
    }),
    failurePolicy: Type.Optional(
      Type.Union([Type.Literal("fail-fast"), Type.Literal("continue")], {
        description: "Stop on the first failed task or preserve failures for downstream tasks",
        default: "fail-fast",
      }),
    ),
  },
  { additionalProperties: false },
);

type OrchestrationInput = Static<typeof orchestrationSchema>;

export default function langGraphExtension(pi: ExtensionAPI): void {
  const compatiblePi = pi as CompatibleExtensionAPI;
  pi.registerTool<typeof orchestrationSchema, OrchestrationDetails>({
    name: TOOL_NAME,
    label: "LangGraph Orchestrate",
    description:
      "Execute a dependency-aware task graph. LangGraph owns fan-out, joins, state, and failure routing; Pi workers own model turns, tools, permissions, cancellation, and execution logs.",
    promptSnippet: "Run dependency-aware parallel Pi workers with LangGraph",
    promptGuidelines: [
      `Use ${TOOL_NAME} only when work has at least two genuinely independent or dependency-linked tasks.`,
      "Give each task a self-contained prompt and declare every dependency explicitly.",
      "Prefer fail-fast unless downstream work can use partial or failed dependency results.",
    ],
    parameters: orchestrationSchema,
    executionMode: "parallel",
    async execute(_toolCallId, params: OrchestrationInput, signal, onUpdate, context) {
      const usesNativeTaskTool =
        compatiblePi.executeTool !== undefined && compatiblePi.getActiveTools().includes(DEFAULT_AGENT_TOOL);
      const executor = createTaskExecutor(compatiblePi, context);
      const result = await runOrchestration(params, executor, {
        ...(signal ? { signal } : {}),
        ...(onUpdate
          ? {
              onProgress: (progress) => {
                onUpdate({
                  content: [
                    {
                      type: "text",
                      text: `${progress.taskId}: ${progress.status} (${progress.completed}/${progress.total})`,
                    },
                  ],
                  details: {
                    objective: params.objective,
                    status: "running",
                    progress,
                  },
                });
              },
            }
          : {}),
      });

      const completed = result.results.filter((task) => task.status === "completed").length;
      const failed = result.results.length - completed;
      const worker = usesNativeTaskTool ? `native ${DEFAULT_AGENT_TOOL} tool` : "Pi SDK session";
      return {
        content: [
          {
            type: "text",
            text: `LangGraph completed ${completed}/${result.results.length} tasks via ${worker}${failed ? `; ${failed} failed` : ""}.\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
        details: result,
      };
    },
  });
}

export { buildTaskPrompt, resultText } from "./executors.ts";
export { runOrchestration } from "./graph.ts";
export { InvalidPlanError, validatePlan } from "./plan.ts";
export type * from "./types.ts";

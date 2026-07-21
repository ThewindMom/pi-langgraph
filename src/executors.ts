import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_AGENT_TOOL,
  TOOL_NAME,
  type CompatibleExtensionAPI,
  type ExecutionRequest,
  type RuntimeContext,
  type TaskExecutor,
} from "./types.ts";

export function createTaskExecutor(pi: CompatibleExtensionAPI, context: RuntimeContext): TaskExecutor {
  if (pi.executeTool && pi.getActiveTools().includes(DEFAULT_AGENT_TOOL)) {
    return createNativeToolExecutor(pi.executeTool.bind(pi));
  }
  return createSdkExecutor(context);
}

function createNativeToolExecutor(executeTool: NonNullable<CompatibleExtensionAPI["executeTool"]>): TaskExecutor {
  return {
    async execute(request, signal) {
      const result = await executeTool(
        DEFAULT_AGENT_TOOL,
        {
          prompt: buildTaskPrompt(request),
          ...(request.task.agent ? { subagent_type: request.task.agent } : {}),
          ...(request.task.model ? { model: request.task.model } : {}),
          name: request.task.id,
          run_in_background: false,
        },
        signal ? { signal } : undefined,
      );
      const details = isRecord(result.details) ? result.details : undefined;
      const status = typeof details?.status === "string" ? details.status.toLowerCase() : undefined;
      if (details?.isError === true || status === "failed" || status === "error" || status === "cancelled") {
        throw new Error(resultText(result) || `Pi worker ${request.task.id} failed`);
      }
      const output = resultText(result);
      if (output.length === 0) throw new Error(`Pi worker ${request.task.id} returned no text`);
      return output;
    },
  };
}

function createSdkExecutor(context: RuntimeContext): TaskExecutor {
  return {
    async execute(request, signal) {
      // Upstream Pi has no executeTool API, so only this host-specific fallback loads its SDK.
      const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");
      const sessionManager = SessionManager.inMemory(context.cwd);
      const { session } = await createAgentSession({
        cwd: context.cwd,
        sessionManager,
        excludeTools: [TOOL_NAME],
        ...(context.model ? { model: context.model as never } : {}),
      });

      const abort = () => void session.abort().catch(() => {});
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
        await session.prompt(buildTaskPrompt(request));
        const output = lastAssistantText(session.messages);
        if (output.length === 0) throw new Error(`Pi worker ${request.task.id} returned no text`);
        return output;
      } finally {
        signal?.removeEventListener("abort", abort);
        session.dispose();
      }
    },
  };
}

export function buildTaskPrompt(request: ExecutionRequest): string {
  const dependencies = request.dependencyResults.length
    ? request.dependencyResults
        .map((result) => {
          const body = result.status === "completed" ? result.output : `ERROR: ${result.error}`;
          return `<dependency id=${JSON.stringify(result.id)} status=${JSON.stringify(result.status)}>\n${body ?? ""}\n</dependency>`;
        })
        .join("\n\n")
    : "(none)";

  return [
    `Overall objective: ${request.objective}`,
    `Your task (${request.task.id}): ${request.task.prompt}`,
    "Dependency results:",
    dependencies,
    "Complete only this task. Return a concise result for downstream tasks; do not orchestrate other agents.",
  ].join("\n\n");
}

export function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (typeof message.errorMessage === "string" && message.errorMessage.length > 0) {
      throw new Error(message.errorMessage);
    }
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) continue;
    return content
      .filter((part): part is Readonly<Record<string, unknown>> => isRecord(part) && part.type === "text")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("\n")
      .trim();
  }
  return "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function actionEnvelope<T>(text: string, details: T) {
  return { content: [{ type: "text" as const, text }], details };
}

export function renderProgress(progress: {
  readonly taskId: string;
  readonly status: string;
  readonly completed: number;
  readonly total: number;
}): string {
  return `${progress.taskId}: ${progress.status} (${progress.completed}/${progress.total})`;
}

export function workflowMessage(
  kind: "progress" | "result",
  result: AgentToolResult<unknown>,
) {
  return {
    customType: `pi-langgraph-${kind}`,
    content: result.content,
    display: true,
    details: result.details,
  };
}

export function workflowFailureMessage(error: unknown) {
  const status = error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  const message = error instanceof Error ? error.message : String(error);
  return {
    customType: "pi-langgraph-result",
    content: `LangGraph workflow ${status}: ${message}`,
    display: true,
    details: { status, error: message },
  };
}

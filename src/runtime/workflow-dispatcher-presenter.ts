import type {
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-coding-agent";
import { actionEnvelope, renderProgress } from "../extension-responses.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { DEFAULT_AGENT_TOOL } from "../types.ts";
import type { WorkflowEvent } from "../workflow/stream-events.ts";
import type {
  CodingRunOptions,
  CodingRunResult,
  CodingWorkflowResult,
} from "../workflow/types.ts";
import type { AutomaticBacktrackResult } from "./automatic-backtrack.ts";
import type {
  ExtensionDetails,
  OrchestrationDispatchRequest,
  OrchestrationDispatcherObserver,
} from "./orchestration-dispatcher.ts";
import { RepositoryServices } from "./repository-services.ts";

export type AutomaticBacktrackWorkflowDetails = CodingWorkflowResult & Readonly<{
  automaticBacktrack: AutomaticBacktrackResult;
}>;

type WorkflowCallbacks = Readonly<{
  options: Pick<CodingRunOptions, "onProgress" | "onEvent">;
  flush: () => Promise<void>;
}>;

export function workflowCallbacks(
  onUpdate: AgentToolUpdateCallback<ExtensionDetails> | undefined,
  observer: OrchestrationDispatcherObserver | undefined,
  context: OrchestrationDispatchRequest["context"],
  objective: string,
): WorkflowCallbacks {
  let pending = Promise.resolve();
  const onEvent = (event: WorkflowEvent): void => {
    if (observer?.onWorkflowEvent !== undefined) {
      pending = pending.then(() => observer.onWorkflowEvent?.(event, context));
    }
    if (onUpdate === undefined) return;
    const terminal = event.kind === "terminal";
    const progress = {
      taskId: `${event.namespace}:${event.kind}`,
      status: terminal ? "completed" as const : "started" as const,
      completed: terminal ? 1 : 0,
      total: 1,
    };
    onUpdate({
      content: [{ type: "text", text: `workflow-event:${JSON.stringify(event)}` }],
      details: { objective, status: "running", progress },
    });
  };
  const onProgress = onUpdate === undefined
    ? undefined
    : (progress: Parameters<NonNullable<CodingRunOptions["onProgress"]>>[0]) => {
      onUpdate({
        content: [{ type: "text", text: renderProgress(progress) }],
        details: { objective, status: "running", progress },
      });
    };
  return {
    options: {
      ...(onProgress === undefined ? {} : { onProgress }),
      onEvent,
    },
    flush: () => pending,
  };
}

export async function recordWorkflowResult(
  checkpoints: FileCheckpointSaver,
  services: RepositoryServices,
  result: CodingRunResult,
): Promise<void> {
  const tuple = await checkpoints.getTuple({
    configurable: { thread_id: result.threadId },
  });
  if (tuple === undefined) throw new WorkflowPresentationError("completed workflow checkpoint is missing");
  await services.recordResult(result, tuple.checkpoint.id, tuple);
}

export function startedUpdate(
  threadId: string,
  objective: string,
): Parameters<AgentToolUpdateCallback<ExtensionDetails>>[0] {
  return {
    content: [{ type: "text", text: `workflow: started (thread ${threadId})` }],
    details: {
      objective,
      status: "running",
      progress: { taskId: threadId, status: "started", completed: 0, total: 1 },
    },
  };
}

export function workflowEnvelope(
  result: CodingRunResult | AutomaticBacktrackWorkflowDetails,
  native: boolean,
): AgentToolResult<ExtensionDetails> {
  const worker = native ? `native ${DEFAULT_AGENT_TOOL} tool` : "Pi SDK session";
  if (result.status === "awaiting_approval") {
    return actionEnvelope(
      `LangGraph analyzed ${result.workItems.length} work units via ${worker} and paused before mutation. Show the scoped interrupt to the user; resume only from a later user decision with its exact binding.`,
      result,
    );
  }
  const backtrack = "automaticBacktrack" in result
    ? ` Automatic backtrack outcome: ${result.automaticBacktrack.kind}.`
    : "";
  return actionEnvelope(
    `${result.summary}\n\nWorkflow ${result.status} via ${worker}; ${result.findings.length} findings, ${result.changes.length} change sets, ${result.verification?.checks.length ?? 0} verification checks.${backtrack}`,
    result,
  );
}

class WorkflowPresentationError extends Error {
  readonly name = "WorkflowPresentationError";
}

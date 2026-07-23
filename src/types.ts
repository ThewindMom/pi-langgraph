import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { PiSessionReader } from "./bridge/session-checkpoint-bridge.ts";

export const TOOL_NAME = "langgraph_orchestrate";
export const DEFAULT_AGENT_TOOL = "task";

export interface WorkerTask {
  readonly id: string;
  readonly prompt: string;
  readonly allowedFiles?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly agent?: string;
  readonly model?: string;
}

export interface WorkerResult {
  readonly id: string;
  readonly status: "completed" | "failed";
  readonly output?: string;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ExecutionRequest {
  readonly objective: string;
  readonly task: WorkerTask;
  readonly dependencyResults: readonly WorkerResult[];
}

export interface ProgressEvent {
  readonly taskId: string;
  readonly status: "started" | "completed" | "failed";
  readonly completed: number;
  readonly total: number;
  readonly message?: string;
}

export type TaskLifecycleStatus = "started" | "running" | "completed" | "failed" | "cancelled";

export interface TaskLifecycleEvent {
  readonly taskId: string;
  readonly status: TaskLifecycleStatus;
  readonly message?: string;
}

export interface TaskExecutionOptions {
  readonly onEvent?: (event: TaskLifecycleEvent) => void;
  readonly workingDirectory?: string;
}
export interface WorkflowProgress {
  readonly objective: string;
  readonly status: "running";
  readonly progress: ProgressEvent;
}

export type ProgressReporter = (event: ProgressEvent) => void;

export interface TaskExecutor {
  execute(request: ExecutionRequest, signal?: AbortSignal, options?: TaskExecutionOptions): Promise<string>;
}

export type ExecuteTool = (
  toolName: string,
  params: unknown,
  options?: {
    readonly signal?: AbortSignal;
    readonly onUpdate?: (update: AgentToolResult<unknown>) => void;
  },
) => Promise<AgentToolResult<unknown>>;

export type CompatibleExtensionAPI = Pick<ExtensionAPI, "getActiveTools"> & {
  readonly executeTool?: ExecuteTool;
};

interface LangGraphInputAPI {
  on(
    event: "input",
    handler: (
      event: InputEvent,
      context: RuntimeContext & { readonly signal?: AbortSignal | undefined },
    ) => InputEventResult | Promise<InputEventResult>,
  ): void;
}

export type LangGraphExtensionAPI = CompatibleExtensionAPI &
  Partial<LangGraphInputAPI> &
  Partial<Pick<ExtensionAPI, "appendEntry" | "sendMessage" | "setLabel">> &
  Pick<ExtensionAPI, "registerTool">;

export type RuntimeContext = Pick<ExtensionContext, "cwd" | "model"> & {
  readonly sessionManager?: PiSessionReader;
};
export type PiLifecycleContext = RuntimeContext & {
  readonly sessionManager: PiSessionReader;
};

type LifecycleHandler<Event, Result = void> = (
  event: Event,
  context: PiLifecycleContext,
) => Result | Promise<Result | void> | void;

export interface PiLifecycleAPI {
  appendEntry(customType: string, data?: unknown): void;
  setLabel(entryId: string, label: string | undefined): void;
  on(event: "session_start", handler: LifecycleHandler<SessionStartEvent>): void;
  on(
    event: "session_before_tree",
    handler: LifecycleHandler<SessionBeforeTreeEvent, Readonly<{ cancel?: boolean }>>,
  ): void;
  on(event: "session_tree", handler: LifecycleHandler<SessionTreeEvent>): void;
  on(
    event: "session_before_fork",
    handler: LifecycleHandler<SessionBeforeForkEvent, Readonly<{ cancel?: boolean }>>,
  ): void;
}

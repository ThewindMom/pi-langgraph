import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TOOL_NAME = "langgraph_orchestrate";
export const DEFAULT_AGENT_TOOL = "task";
export const MAX_TASKS = 32;

export type FailurePolicy = "fail-fast" | "continue";

export interface OrchestrationTask {
  readonly id: string;
  readonly prompt: string;
  readonly dependsOn?: readonly string[];
  readonly agent?: string;
  readonly model?: string;
}

export interface OrchestrationPlan {
  readonly objective: string;
  readonly tasks: readonly OrchestrationTask[];
  readonly failurePolicy?: FailurePolicy;
}

export interface TaskResult {
  readonly id: string;
  readonly status: "completed" | "failed";
  readonly output?: string;
  readonly error?: string;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface OrchestrationResult {
  readonly objective: string;
  readonly status: "completed" | "completed_with_errors";
  readonly results: readonly TaskResult[];
}

export interface ExecutionRequest {
  readonly objective: string;
  readonly task: OrchestrationTask;
  readonly dependencyResults: readonly TaskResult[];
}

export interface ProgressEvent {
  readonly taskId: string;
  readonly status: "started" | "completed" | "failed";
  readonly completed: number;
  readonly total: number;
  readonly message?: string;
}
export interface OrchestrationProgress {
  readonly objective: string;
  readonly status: "running";
  readonly progress: ProgressEvent;
}

export type OrchestrationDetails = OrchestrationResult | OrchestrationProgress;


export type ProgressReporter = (event: ProgressEvent) => void;

export interface TaskExecutor {
  execute(request: ExecutionRequest, signal?: AbortSignal): Promise<string>;
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

export type LangGraphExtensionAPI = CompatibleExtensionAPI & Pick<ExtensionAPI, "registerTool">;

export type RuntimeContext = Pick<ExtensionContext, "cwd" | "model">;

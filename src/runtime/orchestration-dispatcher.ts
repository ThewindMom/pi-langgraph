import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { createRepositoryExecutionPolicy, createTaskExecutor } from "../executors.ts";
import { actionEnvelope } from "../extension-responses.ts";
import type { ResolvedCheckpointLink } from "../bridge/session-checkpoint-bridge.ts";
import { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import {
  type LangGraphExtensionAPI,
  type RuntimeContext,
  type WorkflowProgress,
} from "../types.ts";
import { forkWorkflowCheckpoint } from "../workflow/forks.ts";
import {
  getWorkflowHistory,
  listWorkflowThreads,
} from "../workflow/runtime.ts";
import type { CodingRunResult } from "../workflow/types.ts";
import type { WorkflowEvent } from "../workflow/stream-events.ts";
import { WorktreeManager, type ForkManifest } from "../workspace/worktree-manager.ts";
import { cleanupAutomaticBacktrackState } from "./automatic-backtrack.ts";
import type { OrchestrationInput } from "./public-contract.ts";
import { RepositoryServices } from "./repository-services.ts";
import { dispatchWorkflow } from "./workflow-dispatcher-run.ts";
import type { AutomaticBacktrackWorkflowDetails } from "./workflow-dispatcher-presenter.ts";

type PublicActionDetails =
  | { readonly action: "list"; readonly threadIds: readonly string[] }
  | {
      readonly action: "history";
      readonly threadId: string;
      readonly history: Awaited<ReturnType<typeof getWorkflowHistory>>;
    }
  | { readonly action: "fork"; readonly manifest: ForkManifest };

export type ExtensionDetails =
  | WorkflowProgress
  | CodingRunResult
  | AutomaticBacktrackWorkflowDetails
  | PublicActionDetails;

export interface OrchestrationDispatchRequest {
  readonly input: OrchestrationInput;
  readonly context: RuntimeContext;
  readonly signal?: AbortSignal;
  readonly onUpdate?: AgentToolUpdateCallback<ExtensionDetails>;
}

export type OrchestrationDispatcher = (
  request: OrchestrationDispatchRequest,
) => Promise<AgentToolResult<ExtensionDetails>>;

export type OrchestrationDispatcherObserver = Readonly<{
  onWorkflowEvent?: (
    event: WorkflowEvent,
    context: RuntimeContext,
  ) => Promise<void>;
  resolveActiveLink?: (
    context: RuntimeContext,
  ) => Promise<ResolvedCheckpointLink | undefined>;
}>;

export function createOrchestrationDispatcher(
  pi: LangGraphExtensionAPI,
  dataRoot: string,
  observer?: OrchestrationDispatcherObserver,
): OrchestrationDispatcher {
  let saverPromise: Promise<FileCheckpointSaver> | undefined;
  let worktreePromise: Promise<WorktreeManager> | undefined;
  let snapshotStorePromise: Promise<RepositorySnapshotStore> | undefined;
  const durableSaver = () => {
    saverPromise ??= FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
    return saverPromise;
  };
  const worktrees = () => {
    worktreePromise ??= WorktreeManager.open(join(dataRoot, "forks"));
    return worktreePromise;
  };
  const snapshots = () => {
    snapshotStorePromise ??= RepositorySnapshotStore.open(dataRoot);
    return snapshotStorePromise;
  };

  return async function dispatchOrchestration(request) {
    const { input, context } = request;
    const checkpointer = await durableSaver();
    await cleanupAutomaticBacktrackState(dataRoot, checkpointer);
    if ("action" in input) {
      const action = input.action;
      switch (action) {
        case "list":
          return actionEnvelope("Workflow threads listed.", {
            action: "list",
            threadIds: await listWorkflowThreads(checkpointer),
          });
        case "history":
          return actionEnvelope("Workflow history loaded.", {
            action: "history",
            threadId: input.threadId,
            history: await getWorkflowHistory(checkpointer, input.threadId),
          });
        case "fork": {
          const manager = await worktrees();
          const sourceFork = await manager.getFork(input.sourceThreadId);
          const sourceCwd = sourceFork?.workspacePath ?? context.cwd;
          const services = await RepositoryServices.open(dataRoot, sourceCwd, {
            executor: createTaskExecutor(pi, { ...context, cwd: sourceCwd }),
            policy: createRepositoryExecutionPolicy(pi, { ...context, cwd: sourceCwd }),
          });
          const manifest = await forkWorkflowCheckpoint({
            checkpointer,
            worktreeManager: manager,
            snapshotStore: await snapshots(),
            sourceCwd,
            sourceThreadId: input.sourceThreadId,
            checkpointId: input.checkpointId,
            gitCommit: input.gitCommit,
            forkThreadId: input.forkThreadId,
            retainArtifacts: (forkThreadId, refs) => services.retainFork(forkThreadId, refs),
          });
          return actionEnvelope(`Workflow fork ${input.forkThreadId} created.`, {
            action: "fork",
            manifest,
          });
        }
        default:
          return assertNever(action);
      }
    }
    return dispatchWorkflow(request, {
      pi,
      dataRoot,
      checkpoints: checkpointer,
      snapshotStore: await snapshots(),
      worktrees: await worktrees(),
      ...(observer === undefined ? {} : { observer }),
    });
  };
}

function assertNever(value: never): never {
  throw new UnexpectedOrchestrationActionError(value);
}

class UnexpectedOrchestrationActionError extends Error {
  readonly action: never;

  constructor(action: never) {
    super(`unexpected orchestration action: ${String(action)}`);
    this.name = "UnexpectedOrchestrationActionError";
    this.action = action;
  }
}

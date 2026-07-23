import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type {
  LangGraphExtensionAPI,
  PiLifecycleAPI,
  PiLifecycleContext,
  RuntimeContext,
} from "../types.ts";
import type { WorkflowEvent } from "../workflow/stream-events.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
} from "../persistence/checkpoint-replay-metadata.ts";
import { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { RepositorySnapshotStore } from "../repository/repository-snapshot-store.ts";
import { forkWorkflowCheckpoint } from "../workflow/forks.ts";
import { WorktreeManager } from "../workspace/worktree-manager.ts";
import { ExtensionLifecycle } from "./extension-lifecycle.ts";
import type { ExtensionLifecycleObserver, LifecycleFailure } from "./extension-lifecycle-types.ts";
import {
  PiSessionCheckpointBridge,
  type BridgeResourceResolver,
} from "./session-checkpoint-bridge.ts";
import { BridgeIntentStore } from "./store.ts";
import type {
  SemanticCheckpointLabel,
  SessionCheckpointLinkV1,
} from "./types.ts";

type CheckpointEvent = Extract<WorkflowEvent, Readonly<{ kind: "checkpoint" }>>;
type FailureReporter = (failure: LifecycleFailure, context: PiLifecycleContext) => void;
type DurableLifecycleResources = Readonly<{
  saver: Promise<FileCheckpointSaver>;
  snapshots: Promise<RepositorySnapshotStore>;
  worktrees: Promise<WorktreeManager>;
}>;

export function supportsPiLifecycle(
  pi: LangGraphExtensionAPI,
): pi is LangGraphExtensionAPI & PiLifecycleAPI {
  return pi.on !== undefined &&
    typeof pi.appendEntry === "function" &&
    typeof pi.setLabel === "function";
}

export function supportsLifecycleContext(
  context: RuntimeContext,
): context is PiLifecycleContext {
  const manager = context.sessionManager;
  return typeof manager === "object" &&
    manager !== null &&
    "getSessionId" in manager &&
    typeof manager.getSessionId === "function" &&
    "getLeafId" in manager &&
    typeof manager.getLeafId === "function" &&
    "getEntry" in manager &&
    typeof manager.getEntry === "function" &&
    "getEntries" in manager &&
    typeof manager.getEntries === "function";
}

export function createDurableExtensionLifecycle(
  pi: PiLifecycleAPI,
  dataRoot: string,
  failure?: FailureReporter,
): ExtensionLifecycle {
  const saver = FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
  const store = BridgeIntentStore.open(join(dataRoot, "bridge-intents"));
  const worktrees = WorktreeManager.open(join(dataRoot, "fork-worktrees"));
  const durable = {
    saver,
    snapshots: RepositorySnapshotStore.open(dataRoot),
    worktrees,
  } satisfies DurableLifecycleResources;
  const resources = new DurableBridgeResources(saver, worktrees);
  const observer = createDurableObserver(durable, failure);
  return new ExtensionLifecycle(
    async (context) => new PiSessionCheckpointBridge(
      context.sessionManager,
      pi,
      await store,
      resources,
    ),
    observer,
  );
}

function createDurableObserver(
  resources: DurableLifecycleResources,
  failure?: FailureReporter,
): ExtensionLifecycleObserver {
  return {
    resolveCheckpointLink: async (event, label) =>
      checkpointLink(await resources.saver, event.threadId, event.checkpointId, label),
    resolveCompletedLink: async (details) => completedLink(await resources.saver, details),
    prepareTree: async () => ({ kind: "accepted" }),
    treeSelected: async () => undefined,
    prepareFork: async (resolved, _event, context) => {
      const baselineHead = resolved.link.repositorySnapshot.baselineHead;
      if (baselineHead === null) {
        return { kind: "rejected", reason: "fork requires a retained Git checkpoint" };
      }
      const forkThreadId = `pi-fork-${randomUUID()}`;
      const manifest = await forkWorkflowCheckpoint({
        checkpointer: await resources.saver,
        worktreeManager: await resources.worktrees,
        snapshotStore: await resources.snapshots,
        sourceCwd: context.cwd,
        sourceThreadId: resolved.link.threadId,
        checkpointId: resolved.link.checkpointId,
        gitCommit: baselineHead,
        forkThreadId,
      });
      const destinationLink = await checkpointLink(
        await resources.saver,
        forkThreadId,
        resolved.link.checkpointId,
        resolved.link.label,
      );
      if (destinationLink === undefined) {
        await (await resources.worktrees).cleanup(forkThreadId);
        await (await resources.saver).deleteThread(forkThreadId);
        return { kind: "rejected", reason: "fork checkpoint binding is unavailable" };
      }
      return {
        kind: "accepted",
        destinationLink,
        worktree: {
          protocolVersion: 1,
          kind: "fork",
          forkThreadId,
          path: manifest.workspacePath,
        },
      };
    },
    ...(failure === undefined ? {} : { failure }),
  };
}

async function completedLink(
  saver: FileCheckpointSaver,
  details: unknown,
): Promise<SessionCheckpointLinkV1 | undefined> {
  if (!isCompletedWorkflow(details)) return undefined;
  const tuple = await saver.getTuple({ configurable: { thread_id: details.threadId } });
  if (tuple === undefined) return undefined;
  const replay = checkpointReplayMetadata(tuple.metadata);
  const label = replay?.semanticLabels.at(-1);
  if (label === undefined) return undefined;
  return checkpointLink(saver, details.threadId, tuple.checkpoint.id, label);
}

async function checkpointLink(
  saver: FileCheckpointSaver,
  threadId: string,
  checkpointId: string,
  label: SemanticCheckpointLabel,
): Promise<SessionCheckpointLinkV1 | undefined> {
  const tuple = await saver.getTuple({
    configurable: { thread_id: threadId, checkpoint_id: checkpointId },
  });
  if (tuple === undefined || tuple.checkpoint.id !== checkpointId) return undefined;
  const replay = checkpointReplayMetadata(tuple.metadata);
  const repository = repositoryCheckpointIdentity(tuple.metadata);
  if (
    replay?.replayBinding === undefined ||
    replay.replayFingerprint === undefined ||
    repository === undefined
  ) {
    return undefined;
  }
  return {
    protocolVersion: 1,
    entryType: "pi-langgraph/checkpoint-link",
    threadId,
    checkpointId,
    label,
    repositorySnapshot: {
      protocolVersion: 1,
      snapshotId: repository.snapshotId,
      baselineHead: repository.head,
    },
    replayFingerprint: replay.replayFingerprint,
    effectLedgerDigest: replay.replayBinding.effectLedgerDigest,
  };
}

class DurableBridgeResources implements BridgeResourceResolver {
  constructor(
    private readonly saver: Promise<FileCheckpointSaver>,
    private readonly worktrees: Promise<WorktreeManager>,
  ) {}

  async checkpointExists(link: SessionCheckpointLinkV1): Promise<boolean> {
    const tuple = await (await this.saver).getTuple({
      configurable: {
        thread_id: link.threadId,
        checkpoint_id: link.checkpointId,
      },
    });
    return tuple?.checkpoint.id === link.checkpointId;
  }

  async managedWorktreeExists(worktree: SessionCheckpointLinkV1["managedWorktree"]): Promise<boolean> {
    if (worktree === undefined) return true;
    if (worktree.kind === "fork") {
      const manifest = await (await this.worktrees).getFork(worktree.forkThreadId);
      if (manifest?.workspacePath !== worktree.path) return false;
    }
    try {
      return (await lstat(worktree.path)).isDirectory();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }
}

function isCompletedWorkflow(
  value: unknown,
): value is Readonly<{ status: "completed"; threadId: string }> {
  return typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === "completed" &&
    "threadId" in value &&
    typeof value.threadId === "string";
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

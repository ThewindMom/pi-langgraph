import type {
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
  PiSessionBridgeError,
  type PiSessionCheckpointBridge,
  type ResolvedCheckpointLink,
} from "./session-checkpoint-bridge.ts";
import type { ManagedWorktreeRefV1, SessionCheckpointLinkV1 } from "./types.ts";
import type { PiLifecycleAPI, PiLifecycleContext } from "../types.ts";
import type { WorkflowEvent } from "../workflow/stream-events.ts";
import type {
  ExtensionLifecycleObserver,
  LifecycleFailure,
} from "./extension-lifecycle-types.ts";
import {
  LifecycleBridgeError,
  LifecycleLinkMismatchError,
} from "./extension-lifecycle-errors.ts";

const DEFAULT_INTENT_TTL_MS = 5 * 60 * 1_000;
type SessionBeforeResult = Readonly<{ cancel?: boolean }>;

export type LifecycleBridgeFactory = (
  context: PiLifecycleContext,
) => Promise<PiSessionCheckpointBridge>;

type PreparedTree = Readonly<{
  bridge: PiSessionCheckpointBridge;
  intentId: string;
  targetEntryId: string;
}>;

type PreparedFork = Readonly<{
  bridge: PiSessionCheckpointBridge;
  destinationLink: SessionCheckpointLinkV1;
  intentId: string;
  worktree: ManagedWorktreeRefV1;
}>;

export class ExtensionLifecycle {
  private preparedTree: PreparedTree | undefined;
  private preparedFork: PreparedFork | undefined;

  constructor(
    private readonly bridgeFactory: LifecycleBridgeFactory,
    private readonly observer: ExtensionLifecycleObserver = {},
    private readonly intentTtlMs = DEFAULT_INTENT_TTL_MS,
  ) {}

  register(pi: PiLifecycleAPI): void {
    pi.on("session_start", (event, context) => this.sessionStart(event, context));
    pi.on("session_before_tree", (event, context) => this.beforeTree(event, context));
    pi.on("session_tree", (event, context) => this.tree(event, context));
    pi.on("session_before_fork", (event, context) => this.beforeFork(event, context));
  }

  async workflowCompleted(details: unknown, context: PiLifecycleContext): Promise<string | undefined> {
    try {
      const link = await this.observer.resolveCompletedLink?.(details, context);
      if (link === undefined) return undefined;
      return await this.appendUniqueLink(link, context);
    } catch (error) {
      this.fail("workflow_completed", error, context);
      return undefined;
    }
  }

  async workflowCheckpoint(event: WorkflowEvent, context: PiLifecycleContext): Promise<readonly string[]> {
    if (
      event.kind !== "checkpoint" ||
      event.namespace !== "root" ||
      event.semanticLabels.length === 0 ||
      this.observer.resolveCheckpointLink === undefined
    ) {
      return [];
    }
    const entryIds: string[] = [];
    try {
      for (const label of event.semanticLabels) {
        const link = await this.observer.resolveCheckpointLink(event, label, context);
        if (link === undefined) continue;
        if (
          link.threadId !== event.threadId ||
          link.checkpointId !== event.checkpointId ||
          link.label !== label
        ) {
          throw new LifecycleLinkMismatchError(event.checkpointId, label);
        }
        const entryId = await this.appendUniqueLink(link, context);
        if (entryId !== undefined) entryIds.push(entryId);
      }
    } catch (error) {
      this.fail("workflow_checkpoint", error, context);
    }
    return entryIds;
  }

  async activeLink(context: PiLifecycleContext): Promise<ResolvedCheckpointLink | undefined> {
    const leafId = context.sessionManager.getLeafId();
    if (leafId === null) return undefined;
    try {
      return await (await this.bridgeFactory(context)).resolveTarget(leafId);
    } catch (error) {
      if (isOrdinaryUnlinkedTree(error)) return undefined;
      throw error;
    }
  }

  private async sessionStart(event: SessionStartEvent, context: PiLifecycleContext): Promise<void> {
    try {
      const destination = await this.bridgeFactory(context);
      await destination.rehydrate();
      if (event.reason !== "fork") {
        this.preparedFork = undefined;
        return;
      }
      const prepared = this.preparedFork;
      this.preparedFork = undefined;
      if (prepared === undefined) return;
      const intent = await prepared.bridge.consumePreparedFork(prepared.intentId, prepared.worktree);
      await destination.appendLink({
        ...prepared.destinationLink,
        managedWorktree: prepared.worktree,
      });
      await this.observer.bindFork?.(intent, context.sessionManager.getSessionId(), context);
    } catch (error) {
      this.fail("session_start", error, context);
    }
  }

  private async beforeTree(
    event: SessionBeforeTreeEvent,
    context: PiLifecycleContext,
  ): Promise<SessionBeforeResult | undefined> {
    this.preparedTree = undefined;
    try {
      const bridge = await this.bridgeFactory(context);
      const resolved = await bridge.resolveTarget(event.preparation.targetId);
      if (this.observer.prepareTree === undefined) return undefined;
      const decision = await this.observer.prepareTree(resolved, event, context);
      if (decision.kind === "rejected") {
        this.reject("session_before_tree", decision.reason, context);
        return { cancel: true };
      }
      const intent = await bridge.prepareTree(event.preparation.targetId, this.intentTtlMs);
      this.preparedTree = { bridge, intentId: intent.intentId, targetEntryId: event.preparation.targetId };
      return undefined;
    } catch (error) {
      if (isOrdinaryUnlinkedTree(error)) return undefined;
      this.fail("session_before_tree", error, context);
      return { cancel: true };
    }
  }

  private async tree(event: SessionTreeEvent, context: PiLifecycleContext): Promise<void> {
    if (event.fromExtension === true) return;
    const prepared = this.preparedTree;
    this.preparedTree = undefined;
    if (prepared === undefined || event.newLeafId !== prepared.targetEntryId) return;
    try {
      const intent = await prepared.bridge.consumePreparedTree(prepared.intentId, prepared.targetEntryId);
      await this.observer.treeSelected?.(intent, event, context);
    } catch (error) {
      this.fail("session_tree", error, context);
    }
  }

  private async beforeFork(
    event: SessionBeforeForkEvent,
    context: PiLifecycleContext,
  ): Promise<SessionBeforeResult | undefined> {
    this.preparedFork = undefined;
    try {
      const bridge = await this.bridgeFactory(context);
      const targetEntryId = forkTargetEntryId(event, context);
      if (targetEntryId === null) return undefined;
      const resolved = await bridge.resolveTarget(targetEntryId);
      if (this.observer.prepareFork === undefined) return undefined;
      const preparation = await this.observer.prepareFork(resolved, event, context);
      if (preparation.kind === "rejected") {
        this.reject("session_before_fork", preparation.reason, context);
        return { cancel: true };
      }
      const intent = await bridge.prepareFork(targetEntryId, preparation.worktree, this.intentTtlMs);
      this.preparedFork = {
        bridge,
        destinationLink: preparation.destinationLink,
        intentId: intent.intentId,
        worktree: preparation.worktree,
      };
      return undefined;
    } catch (error) {
      if (isOrdinaryUnlinkedTree(error)) return undefined;
      this.fail("session_before_fork", error, context);
      return { cancel: true };
    }
  }

  private reject(
    event: LifecycleFailure["event"],
    reason: string,
    context: PiLifecycleContext,
  ): void {
    this.observer.failure?.({ event, reason }, context);
  }

  private fail(
    event: LifecycleFailure["event"],
    value: unknown,
    context: PiLifecycleContext,
  ): void {
    const error = value instanceof Error ? value : new LifecycleBridgeError(value);
    this.observer.failure?.({ event, reason: error.message, error }, context);
  }

  private async appendUniqueLink(
    link: SessionCheckpointLinkV1,
    context: PiLifecycleContext,
  ): Promise<string | undefined> {
    const bridge = await this.bridgeFactory(context);
    const existing = await bridge.rehydrate();
    if (existing.some((resolved) =>
      resolved.link.threadId === link.threadId &&
      resolved.link.checkpointId === link.checkpointId &&
      resolved.link.label === link.label
    )) {
      return undefined;
    }
    return bridge.appendLink(link);
  }
}

function isOrdinaryUnlinkedTree(error: unknown): boolean {
  return error instanceof PiSessionBridgeError && error.code === "missing-link";
}

function forkTargetEntryId(
  event: SessionBeforeForkEvent,
  context: PiLifecycleContext,
): string | null {
  if (event.position === "at") return event.entryId;
  const entry = context.sessionManager.getEntry(event.entryId);
  if (entry === undefined) throw new PiSessionBridgeError("missing-target", event.entryId);
  return entry.parentId;
}

export type {
  ExtensionLifecycleObserver,
  ForkPreparation,
  LifecycleDecision,
  LifecycleFailure,
} from "./extension-lifecycle-types.ts";

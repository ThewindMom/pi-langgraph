import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import {
  ExtensionLifecycle,
  type ExtensionLifecycleObserver,
} from "../src/bridge/extension-lifecycle.ts";
import {
  PiSessionCheckpointBridge,
  type PiSessionEntry,
  type PiSessionReader,
} from "../src/bridge/session-checkpoint-bridge.ts";
import { BridgeIntentStore } from "../src/bridge/store.ts";
import type {
  ManagedWorktreeRefV1,
  SemanticCheckpointLabel,
  SessionCheckpointLinkV1,
} from "../src/bridge/types.ts";
import langGraphExtension, { SEMANTIC_CHECKPOINT_LABELS } from "../src/index.ts";
import type { PiLifecycleContext } from "../src/types.ts";
import type { WorkflowEvent } from "../src/workflow/stream-events.ts";

const LIFECYCLE_EVENTS = [
  "session_start",
  "session_before_tree",
  "session_tree",
  "session_before_fork",
] as const;
const LIFECYCLE_EVENT_SET = new Set<string>(LIFECYCLE_EVENTS);

test("registers the exact Pi session lifecycle bridge events", () => {
  // Given: a Pi-compatible extension host that records event registration.
  const handlers = new Map<string, unknown>();
  const pi = {
    appendEntry() {},
    getActiveTools: () => [],
    on(event: string, handler: unknown) {
      handlers.set(event, handler);
    },
    registerTool() {},
    setLabel() {},
  };

  // When: the extension is registered.
  langGraphExtension(pi);

  // Then: every exact Pi tree/fork lifecycle event has one handler.
  expect([...handlers.keys()].filter((event) => LIFECYCLE_EVENT_SET.has(event))).toEqual(
    [...LIFECYCLE_EVENTS],
  );
  for (const event of LIFECYCLE_EVENTS) expect(handlers.get(event)).toBeFunction();
  expect(SEMANTIC_CHECKPOINT_LABELS).toEqual([
    "post-discovery",
    "pre-mutation",
    "last-known-green",
    "post-repair",
  ]);
});

test("root semantic checkpoints append, label, and deduplicate versioned links", async () => {
  // Given: a lifecycle bridge on a session with one ordinary Pi entry.
  const fixture = await createFixture();
  try {
    const event = checkpointEvent(["post-discovery", "pre-mutation"]);
    const lifecycle = fixture.lifecycle({
      resolveCheckpointLink: (checkpoint, label) =>
        Promise.resolve(link({ checkpointId: checkpoint.checkpointId, label })),
    });

    // When: the same root checkpoint is observed twice alongside ineligible checkpoint events.
    expect(await lifecycle.workflowCheckpoint(event, fixture.context)).toHaveLength(2);
    expect(await lifecycle.workflowCheckpoint(event, fixture.context)).toEqual([]);
    expect(await lifecycle.workflowCheckpoint({
      ...event,
      checkpointId: "checkpoint-2",
      semanticLabels: ["post-repair"],
    }, fixture.context)).toHaveLength(1);
    expect(await lifecycle.workflowCheckpoint({ ...event, namespace: "change/worker" }, fixture.context)).toEqual([]);
    expect(await lifecycle.workflowCheckpoint({ ...event, semanticLabels: [] }, fixture.context)).toEqual([]);

    // Then: one custom entry and one Pi label exist per semantic label, with the latest active lineage resolvable.
    expect(fixture.session.checkpointEntries()).toHaveLength(3);
    expect(fixture.session.labels).toEqual([
      expect.objectContaining({ label: "lg:post-discovery:thread-1:checkpoint-1" }),
      expect.objectContaining({ label: "lg:pre-mutation:thread-1:checkpoint-1" }),
      expect.objectContaining({ label: "lg:post-repair:thread-1:checkpoint-2" }),
    ]);
    expect((await lifecycle.activeLink(fixture.context))?.link.label).toBe("post-repair");
  } finally {
    await fixture.cleanup();
  }
});

test("completed extension workflow appends one latest semantic link", async () => {
  // Given: a completed-workflow resolver bound to its latest known-green checkpoint.
  const fixture = await createFixture();
  try {
    const lifecycle = fixture.lifecycle({
      resolveCompletedLink: () => Promise.resolve(link({ label: "last-known-green" })),
    });

    // When: the same completed extension result is observed more than once.
    const first = await lifecycle.workflowCompleted(
      { status: "completed", threadId: "thread-1" },
      fixture.context,
    );
    const duplicate = await lifecycle.workflowCompleted(
      { status: "completed", threadId: "thread-1" },
      fixture.context,
    );

    // Then: only one versioned custom link is appended and labeled.
    expect(first).toBeString();
    expect(duplicate).toBeUndefined();
    expect(fixture.session.checkpointEntries()).toHaveLength(1);
    expect(fixture.session.labels[0]?.label).toBe("lg:last-known-green:thread-1:checkpoint-1");
  } finally {
    await fixture.cleanup();
  }
});

test("malformed checkpoint binding fails closed without blocking the workflow", async () => {
  // Given: a resolver that attempts to redirect a semantic event to another checkpoint.
  const fixture = await createFixture();
  try {
    const failures: string[] = [];
    const lifecycle = fixture.lifecycle({
      resolveCheckpointLink: (_checkpoint, label) =>
        Promise.resolve(link({ checkpointId: "redirected-checkpoint", label })),
      failure: (failure) => failures.push(`${failure.event}:${failure.reason}`),
    });

    // When: the root checkpoint event crosses the lifecycle boundary.
    const entryIds = await lifecycle.workflowCheckpoint(
      checkpointEvent(["pre-mutation"]),
      fixture.context,
    );

    // Then: the workflow remains usable while the malformed link is rejected without a custom entry.
    expect(entryIds).toEqual([]);
    expect(fixture.session.checkpointEntries()).toEqual([]);
    expect(failures).toEqual([
      "workflow_checkpoint:workflow checkpoint link does not match checkpoint-1:pre-mutation",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("tree navigation runs bounded backtrack without mutating sibling entries", async () => {
  // Given: a linked ancestor, two immutable Pi siblings, and an accepted tree observer.
  const fixture = await createFixture();
  try {
    const treeRuns: string[] = [];
    const lifecycle = fixture.lifecycle({
      prepareTree: () => Promise.resolve({ kind: "accepted" }),
      treeSelected: (intent) => {
        treeRuns.push(intent.resolvedEntryId);
        return Promise.resolve();
      },
    });
    await fixture.bridge.appendLink(link());
    const branchPoint = fixture.session.getLeafId();
    if (branchPoint === null) throw new Error("linked branch point is missing");
    const target = fixture.session.appendNode("message");
    fixture.session.branch(branchPoint);
    const sibling = fixture.session.appendNode("message");
    const entriesBefore = fixture.session.getEntries();

    // When: Pi prepares and completes /tree navigation to the linked target branch.
    const before = await fixture.session.emitBeforeTree(beforeTreeEvent(target), fixture.context);
    fixture.session.branch(target);
    await fixture.session.emitTree(treeEvent(target, sibling), fixture.context);

    // Then: the matching intent is consumed once, active graph lineage follows the target, and no entry changed.
    expect(before).toBeUndefined();
    expect(treeRuns).toHaveLength(1);
    expect((await lifecycle.activeLink(fixture.context))?.link.checkpointId).toBe("checkpoint-1");
    expect(fixture.session.getEntries()).toEqual(entriesBefore);
  } finally {
    await fixture.cleanup();
  }
});

test("blocks incompatible and unknown effects before tree or fork mutation", async () => {
  // Given: a linked target whose preflight observer rejects tree and fork for structured safety reasons.
  const fixture = await createFixture();
  try {
    const failures: string[] = [];
    const lifecycle = fixture.lifecycle({
      prepareTree: () => Promise.resolve({ kind: "rejected", reason: "incompatible-replay" }),
      prepareFork: () => Promise.resolve({ kind: "rejected", reason: "unsafe-effects" }),
      failure: (failure) => failures.push(`${failure.event}:${failure.reason}`),
    });
    const entryId = await fixture.bridge.appendLink(link());
    const entriesBefore = fixture.session.getEntries();

    // When: Pi requests unsafe tree navigation and fork preparation.
    const treeResult = await fixture.session.emitBeforeTree(beforeTreeEvent(entryId), fixture.context);
    const forkResult = await fixture.session.emitBeforeFork(beforeForkEvent(entryId), fixture.context);

    // Then: both operations cancel, create no durable intent, and leave source/session state untouched.
    expect(treeResult).toEqual({ cancel: true });
    expect(forkResult).toEqual({ cancel: true });
    expect(failures).toEqual([
      "session_before_tree:incompatible-replay",
      "session_before_fork:unsafe-effects",
    ]);
    expect(await fixture.store.list()).toEqual([]);
    expect(fixture.session.getEntries()).toEqual(entriesBefore);
    expect(await lifecycle.activeLink(fixture.context)).toEqual(expect.objectContaining({ entryId }));
  } finally {
    await fixture.cleanup();
  }
});

test("fork session start consumes the exact preparation and binds the destination lineage", async () => {
  // Given: a linked source session and one exact managed worktree prepared for Pi fork.
  const fixture = await createFixture();
  try {
    const bindings: string[] = [];
    const worktree = managedWorktree();
    const lifecycle = fixture.lifecycle({
      prepareFork: () => Promise.resolve({
        kind: "accepted",
        worktree,
        destinationLink: link({ threadId: "fork-thread" }),
      }),
      bindFork: (intent, destinationSessionId) => {
        bindings.push(`${intent.resolvedEntryId}:${destinationSessionId}`);
        return Promise.resolve();
      },
    });
    const entryId = await fixture.bridge.appendLink(link());
    const destination = new FakePiSession("session-fork", fixture.session.getEntries(), entryId);
    const destinationContext = contextFor(destination);

    // When: Pi prepares the source fork and starts the copied destination with reason fork.
    expect(await fixture.session.emitBeforeFork(beforeForkEvent(entryId), fixture.context)).toBeUndefined();
    await fixture.session.emitStart({ type: "session_start", reason: "fork" }, destinationContext);

    // Then: only the exact fork intent is consumed and the copied session exposes the selected active binding.
    expect(bindings).toEqual([`${entryId}:session-fork`]);
    expect((await fixture.store.list()).map((intent) => intent.status.kind)).toEqual(["consumed"]);
    expect((await lifecycle.activeLink(destinationContext))?.link.managedWorktree).toEqual(worktree);
    expect(destination.checkpointEntries()).toHaveLength(2);
  } finally {
    await fixture.cleanup();
  }
});

type Fixture = Readonly<{
  bridge: PiSessionCheckpointBridge;
  cleanup(): Promise<void>;
  context: PiLifecycleContext;
  lifecycle(observer: ExtensionLifecycleObserver): ExtensionLifecycle;
  session: FakePiSession;
  store: BridgeIntentStore;
}>;

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-session-lifecycle-"));
  const session = new FakePiSession("session-source");
  session.appendNode("message");
  const store = await BridgeIntentStore.open(root);
  const resources = new ExistingResources();
  const bridge = new PiSessionCheckpointBridge(session, session, store, resources);
  await bridge.rehydrate();
  const context = contextFor(session);
  return {
    bridge,
    context,
    session,
    store,
    cleanup: () => rm(root, { recursive: true, force: true }),
    lifecycle(observer) {
      const controller = new ExtensionLifecycle(async (current) => {
        const manager = current.sessionManager;
        if (!(manager instanceof FakePiSession)) throw new Error("unexpected lifecycle session manager");
        return new PiSessionCheckpointBridge(manager, manager, store, resources);
      }, observer);
      controller.register(session);
      return controller;
    },
  };
}

class ExistingResources {
  checkpointExists(): Promise<boolean> {
    return Promise.resolve(true);
  }

  managedWorktreeExists(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakePiSession implements PiSessionReader {
  readonly labels: Array<Readonly<{ entryId: string; label: string }>> = [];
  private readonly entries: PiSessionEntry[];
  private readonly handlers = new Map<string, unknown>();
  private leafId: string | null;
  private nextId: number;

  constructor(
    private readonly sessionId: string,
    entries: readonly PiSessionEntry[] = [],
    leafId: string | null = entries.at(-1)?.id ?? null,
  ) {
    this.entries = [...entries];
    this.leafId = leafId;
    this.nextId = entries.length + 1;
  }

  on(event: string, handler: unknown): void {
    this.handlers.set(event, handler);
  }

  appendEntry(customType: string, data?: unknown): void {
    this.append({ type: "custom", customType, data });
  }

  setLabel(entryId: string, label: string | undefined): void {
    if (label === undefined) return;
    this.labels.push({ entryId, label });
    this.append({ type: "label" });
  }

  appendNode(type: string): string {
    return this.append({ type });
  }

  branch(entryId: string): void {
    if (this.getEntry(entryId) === undefined) throw new Error(`missing branch entry: ${entryId}`);
    this.leafId = entryId;
  }

  checkpointEntries(): readonly PiSessionEntry[] {
    return this.entries.filter((entry) =>
      entry.type === "custom" && entry.customType === "pi-langgraph/checkpoint-link"
    );
  }

  emitStart(event: SessionStartEvent, context: PiLifecycleContext): Promise<void> {
    return this.invoke("session_start", event, context).then(() => undefined);
  }

  async emitBeforeTree(
    event: SessionBeforeTreeEvent,
    context: PiLifecycleContext,
  ): Promise<Readonly<{ cancel?: boolean }> | undefined> {
    return beforeResult(await this.invoke("session_before_tree", event, context));
  }

  emitTree(event: SessionTreeEvent, context: PiLifecycleContext): Promise<void> {
    return this.invoke("session_tree", event, context).then(() => undefined);
  }

  async emitBeforeFork(
    event: SessionBeforeForkEvent,
    context: PiLifecycleContext,
  ): Promise<Readonly<{ cancel?: boolean }> | undefined> {
    return beforeResult(await this.invoke("session_before_fork", event, context));
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getEntry(id: string): PiSessionEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  getEntries(): readonly PiSessionEntry[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  private append(value: Readonly<{ type: string; customType?: string; data?: unknown }>): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ id, parentId: this.leafId, ...value });
    this.leafId = id;
    return id;
  }

  private async invoke(event: string, payload: unknown, context: PiLifecycleContext): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (typeof handler !== "function") throw new Error(`missing lifecycle handler: ${event}`);
    return Reflect.apply(handler, undefined, [payload, context]);
  }
}

function beforeResult(value: unknown): Readonly<{ cancel?: boolean }> | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "object" &&
    value !== null &&
    "cancel" in value &&
    typeof value.cancel === "boolean"
  ) {
    return { cancel: value.cancel };
  }
  throw new Error("invalid lifecycle before-event result");
}

function contextFor(session: FakePiSession): PiLifecycleContext {
  return { cwd: "/workspace", model: undefined, sessionManager: session };
}

function checkpointEvent(
  semanticLabels: readonly SemanticCheckpointLabel[],
): Extract<WorkflowEvent, Readonly<{ kind: "checkpoint" }>> {
  return {
    runId: "run-1",
    threadId: "thread-1",
    sequence: 1,
    namespace: "root",
    kind: "checkpoint",
    checkpointId: "checkpoint-1",
    semanticLabels,
    detail: "{}",
    artifactRefs: [],
  };
}

function beforeTreeEvent(targetId: string): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId,
      oldLeafId: null,
      commonAncestorId: null,
      entriesToSummarize: [],
      userWantsSummary: false,
    },
    signal: new AbortController().signal,
  };
}

function treeEvent(newLeafId: string, oldLeafId: string): SessionTreeEvent {
  return { type: "session_tree", newLeafId, oldLeafId };
}

function beforeForkEvent(entryId: string): SessionBeforeForkEvent {
  return { type: "session_before_fork", entryId, position: "at" };
}

function managedWorktree(): ManagedWorktreeRefV1 {
  return {
    protocolVersion: 1,
    kind: "candidate",
    candidateIndex: 0,
    worktreeId: "candidate-0",
    path: "/managed/candidate-0",
  };
}

function link(
  overrides: Partial<SessionCheckpointLinkV1> = {},
): SessionCheckpointLinkV1 {
  return {
    protocolVersion: 1,
    entryType: "pi-langgraph/checkpoint-link",
    threadId: "thread-1",
    checkpointId: "checkpoint-1",
    label: "pre-mutation",
    repositorySnapshot: {
      protocolVersion: 1,
      snapshotId: "a".repeat(64),
      baselineHead: null,
    },
    replayFingerprint: "b".repeat(64),
    effectLedgerDigest: "c".repeat(64),
    ...overrides,
  };
}

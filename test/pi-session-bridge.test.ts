import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BridgeIntentStore,
  BridgeIntentStoreError,
} from "../src/bridge/store.ts";
import {
  PiSessionBridgeError,
  PiSessionCheckpointBridge,
  type PiCheckpointHost,
  type PiSessionEntry,
  type PiSessionReader,
} from "../src/bridge/session-checkpoint-bridge.ts";
import type {
  ManagedWorktreeRefV1,
  SessionCheckpointLinkV1,
} from "../src/bridge/types.ts";

test("rehydrates append-only links and resolves the nearest linked ancestor", async () => {
  // Given: a real-shape Pi host whose appendEntry returns void and advances the leaf.
  const root = await mkdtemp(join(tmpdir(), "pi-session-bridge-"));
  const pi = SessionManager.inMemory();
  const host = new PiHostAdapter(pi);
  const resolver = new ExistingResources();
  try {
    const store = await BridgeIntentStore.open(root);
    const first = new PiSessionCheckpointBridge(pi, host, store, resolver);

    // When: a link is appended, labeled, followed by a normal descendant, and reloaded.
    const entryId = await first.appendLink(link());
    const descendantId = pi.appendCustomEntry("unrelated", {});
    const restarted = new PiSessionCheckpointBridge(pi, host, await BridgeIntentStore.open(root), resolver);
    await restarted.rehydrate();
    const exact = await restarted.resolveTarget(entryId);
    const nearest = await restarted.resolveTarget(descendantId);

    // Then: the actual custom-entry id, not its display label or array position, is durable identity.
    expect(pi.getEntry(entryId)?.type).toBe("custom");
    expect(exact).toEqual(nearest);
    expect(exact.entryId).toBe(entryId);
    expect(exact.link).toEqual(link());
    expect(pi.getLabel(entryId)).toBe("lg:pre-mutation:thread-1:checkpoint-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects conflicting duplicate links without labels or prepared intents", async () => {
  // Given: append-only session data with the same outer entry id redirecting to another checkpoint.
  const root = await mkdtemp(join(tmpdir(), "pi-session-bridge-conflict-"));
  const pi = new MemoryPiSession("session-1", [
    customEntry("duplicate", null, link()),
    customEntry("duplicate", null, link({ checkpointId: "checkpoint-2" })),
  ]);
  try {
    const store = await BridgeIntentStore.open(root);
    const bridge = new PiSessionCheckpointBridge(pi, pi, store, new ExistingResources());

    // When / Then: rehydration fails atomically and cannot prepare redirected work.
    await expect(bridge.rehydrate()).rejects.toMatchObject({ code: "conflicting-link" });
    await expect(bridge.prepareTree("duplicate", 1_000)).rejects.toBeInstanceOf(PiSessionBridgeError);
    expect(pi.labels).toEqual([]);
    expect(await store.list()).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed and stale checkpoint links during rehydration", async () => {
  // Given: one corrupt custom payload and one link whose exact checkpoint no longer exists.
  const root = await mkdtemp(join(tmpdir(), "pi-session-bridge-invalid-"));
  try {
    const malformedPi = new MemoryPiSession("session-1", [
      customEntry("malformed", null, { protocolVersion: 2 }),
    ]);
    const malformed = new PiSessionCheckpointBridge(
      malformedPi,
      malformedPi,
      await BridgeIntentStore.open(join(root, "malformed")),
      new ExistingResources(),
    );
    const stalePi = new MemoryPiSession("session-2", [customEntry("stale", null, link())]);
    const stale = new PiSessionCheckpointBridge(
      stalePi,
      stalePi,
      await BridgeIntentStore.open(join(root, "stale")),
      new ExistingResources(false),
    );

    // When / Then: each untrusted session boundary produces its deterministic typed result.
    await expect(malformed.rehydrate()).rejects.toMatchObject({ code: "malformed-link" });
    await expect(stale.rehydrate()).rejects.toMatchObject({ code: "stale-link" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expires preparations and consumes only a matching prepared fork", async () => {
  // Given: a rehydrated link, deterministic clock, and an already prepared managed worktree.
  const root = await mkdtemp(join(tmpdir(), "pi-session-bridge-intent-"));
  let now = 100;
  const pi = new MemoryPiSession("session-1", [customEntry("linked", null, link())]);
  const worktree = managedWorktree();
  try {
    const store = await BridgeIntentStore.open(root, { clock: () => now });
    const bridge = new PiSessionCheckpointBridge(pi, pi, store, new ExistingResources());
    await bridge.rehydrate();
    const tree = await bridge.prepareTree("linked", 10);
    await expect(bridge.consumePreparedFork(tree.intentId, worktree)).rejects.toMatchObject({
      code: "intent-mismatch",
    });
    expect((await bridge.consumePreparedTree(tree.intentId, "linked")).status.kind).toBe("consumed");

    // When: one fork expires and another is reconciled first with the wrong, then exact worktree.
    const expired = await bridge.prepareFork("linked", worktree, 10);
    now = 111;
    const restartedStore = await BridgeIntentStore.open(root, { clock: () => now });
    const restarted = new PiSessionCheckpointBridge(pi, pi, restartedStore, new ExistingResources());
    await restarted.rehydrate();
    await expect(restarted.consumePreparedFork(expired.intentId, worktree)).rejects.toBeInstanceOf(
      BridgeIntentStoreError,
    );
    const prepared = await restarted.prepareFork("linked", worktree, 10);
    const wrong = { ...worktree, path: "/managed/candidate-elsewhere" };
    await expect(restarted.consumePreparedFork(prepared.intentId, wrong)).rejects.toMatchObject({
      code: "intent-mismatch",
    });
    const consumed = await restarted.consumePreparedFork(prepared.intentId, worktree);

    // Then: expiry is durable and only exact prepared identity transitions to consumed.
    expect((await restartedStore.get(expired.intentId))?.status.kind).toBe("expired");
    expect(consumed.status.kind).toBe("consumed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class ExistingResources {
  constructor(private readonly checkpointPresent = true) {}

  checkpointExists(): Promise<boolean> {
    return Promise.resolve(this.checkpointPresent);
  }

  managedWorktreeExists(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class PiHostAdapter implements PiCheckpointHost {
  constructor(private readonly manager: SessionManager) {}

  appendEntry(customType: string, data?: unknown): void {
    this.manager.appendCustomEntry(customType, data);
  }

  setLabel(entryId: string, label: string): void {
    this.manager.appendLabelChange(entryId, label);
  }
}

class MemoryPiSession implements PiSessionReader, PiCheckpointHost {
  readonly labels: { readonly entryId: string; readonly label: string }[] = [];
  private readonly entries: PiSessionEntry[];
  private leafId: string | null;
  private nextId: number;

  constructor(
    private readonly sessionId: string,
    entries: readonly PiSessionEntry[] = [],
  ) {
    this.entries = [...entries];
    this.leafId = entries.at(-1)?.id ?? null;
    this.nextId = entries.length + 1;
  }

  appendEntry(customType: string, data?: unknown): void {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ type: "custom", id, parentId: this.leafId, customType, data });
    this.leafId = id;
  }

  setLabel(entryId: string, label: string): void {
    this.labels.push({ entryId, label });
    this.appendNode("label");
  }

  appendNode(type: string): string {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ type, id, parentId: this.leafId });
    this.leafId = id;
    return id;
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
    return [...this.entries];
  }
}

function customEntry(id: string, parentId: string | null, data: unknown): PiSessionEntry {
  return { type: "custom", id, parentId, customType: "pi-langgraph/checkpoint-link", data };
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

function link(overrides: Partial<SessionCheckpointLinkV1> = {}): SessionCheckpointLinkV1 {
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

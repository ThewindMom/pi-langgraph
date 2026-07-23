import { expect, test } from "bun:test";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionStartEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { decodeSessionCheckpointLink } from "../src/bridge/codec.ts";
import type { PiSessionEntry, PiSessionReader } from "../src/bridge/session-checkpoint-bridge.ts";
import { BridgeIntentStore } from "../src/bridge/store.ts";
import type { SessionCheckpointLinkV1 } from "../src/bridge/types.ts";
import langGraphExtension from "../src/index.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
  type ReplaySafetyContext,
} from "../src/persistence/checkpoint-replay-metadata.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { createRepositorySnapshot } from "../src/repository/snapshot.ts";
import type { PiLifecycleContext } from "../src/types.ts";
import { WorktreeManager } from "../src/workspace/worktree-manager.ts";

const replaySafety: ReplaySafetyContext = {
  bridgeProtocolVersion: 1,
  workflowVersion: 2,
  stateVersion: 3,
  workflowInput: { objective: "fork the selected lineage", approval: "before_changes" },
  toolModelConfigDigest: "b".repeat(64),
  effectLedgerDigest: "c".repeat(64),
};

test("registered lifecycle consumes a production tree-selection intent", async () => {
  // Given: the registered extension and a Pi session linked to a durable graph checkpoint.
  const fixture = await createFixture();
  try {
    const target = fixture.source.getLeafId();
    if (target === null) throw new Error("source link is missing");

    // When: Pi selects the linked tree through the registered lifecycle handlers.
    expect(await fixture.host.emitBeforeTree(beforeTreeEvent(target), fixture.context)).toBeUndefined();
    await fixture.host.emitTree({ type: "session_tree", newLeafId: target, oldLeafId: target }, fixture.context);

    // Then: production created and consumed the exact durable tree intent.
    const intents = await (await BridgeIntentStore.open(join(fixture.dataRoot, "bridge-intents"))).list();
    expect(intents.map((intent) => [intent.kind, intent.status.kind])).toEqual([["tree", "consumed"]]);
  } finally {
    await fixture.cleanup();
  }
});

test("registered lifecycle forks graph and Git state before binding only the destination", async () => {
  // Given: a clean source repository and registered extension linked to its exact checkpoint.
  const fixture = await createFixture();
  let forkThreadId: string | undefined;
  try {
    const target = fixture.source.getLeafId();
    if (target === null) throw new Error("source link is missing");
    const entriesBefore = fixture.source.getEntries();
    const headBefore = git(fixture.repositoryRoot, ["rev-parse", "HEAD"]);
    const statusBefore = git(fixture.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);

    // When: Pi prepares the fork, then starts the copied destination session.
    expect(await fixture.host.emitBeforeFork(beforeForkEvent(target), fixture.context)).toBeUndefined();
    const destination = new FakeSession("destination-session", fixture.source.getEntries(), target);
    fixture.host.activate(destination);
    await fixture.host.emitStart(
      { type: "session_start", reason: "fork" },
      { ...fixture.context, sessionManager: destination },
    );

    // Then: destination points at an isolated graph thread and manager-owned fork worktree.
    const destinationLink = latestLink(destination);
    forkThreadId = destinationLink.threadId;
    expect(destinationLink.threadId).not.toBe(fixture.sourceLink.threadId);
    expect(destinationLink.checkpointId).toBe(fixture.sourceLink.checkpointId);
    expect(destinationLink.managedWorktree).toMatchObject({ kind: "fork", forkThreadId });
    const reopenedSaver = await FileCheckpointSaver.open(join(fixture.dataRoot, "checkpoints"));
    expect([...await reopenedSaver.listThreads()].sort()).toEqual(
      [fixture.sourceLink.threadId, forkThreadId].sort(),
    );
    const worktreeManager = await WorktreeManager.open(join(fixture.dataRoot, "fork-worktrees"));
    expect(await worktreeManager.getFork(forkThreadId))
      .toMatchObject({ forkThreadId, workspacePath: destinationLink.managedWorktree?.path });
    expect(fixture.source.getEntries()).toEqual(entriesBefore);
    expect(git(fixture.repositoryRoot, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(fixture.repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]))
      .toBe(statusBefore);
  } finally {
    if (forkThreadId !== undefined) {
      await (await WorktreeManager.open(join(fixture.dataRoot, "fork-worktrees"))).cleanup(forkThreadId);
    }
    await fixture.cleanup();
  }
});

type Fixture = Readonly<{
  cleanup(): Promise<void>;
  context: PiLifecycleContext;
  dataRoot: string; host: RegisteredHost;
  repositoryRoot: string;
  source: FakeSession;
  sourceLink: SessionCheckpointLinkV1;
}>;

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-lifecycle-defaults-"));
  const agentRoot = join(root, "agent");
  const dataRoot = join(agentRoot, "extensions", "pi-langgraph", "data");
  const repositoryRoot = join(root, "repository");
  await mkdir(repositoryRoot);
  await writeFile(join(repositoryRoot, "source.ts"), "export const source = true;\n");
  git(repositoryRoot, ["init"]);
  git(repositoryRoot, ["config", "user.name", "Pi Lifecycle Test"]);
  git(repositoryRoot, ["config", "user.email", "pi-lifecycle@example.invalid"]);
  git(repositoryRoot, ["add", "."]);
  git(repositoryRoot, ["commit", "-m", "source"]);
  const snapshot = await createRepositorySnapshot(repositoryRoot);
  const saver = await FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
  saver.bindRepositorySnapshot("source-thread", {
    protocolVersion: 1,
    snapshotId: snapshot.snapshotId,
    head: snapshot.head,
  });
  saver.bindReplaySafety("source-thread", replaySafety);
  await saver.put(
    { configurable: { thread_id: "source-thread" } },
    checkpoint("source-checkpoint"),
    { source: "loop", step: 1, parents: {} },
    {},
  );
  const tuple = await saver.getTuple({
    configurable: { thread_id: "source-thread", checkpoint_id: "source-checkpoint" },
  });
  const replay = checkpointReplayMetadata(tuple?.metadata);
  const repository = repositoryCheckpointIdentity(tuple?.metadata);
  if (replay?.replayFingerprint === undefined || replay.replayBinding === undefined || repository === undefined) {
    throw new Error("source checkpoint replay binding is missing");
  }
  const sourceLink: SessionCheckpointLinkV1 = {
    protocolVersion: 1,
    entryType: "pi-langgraph/checkpoint-link",
    threadId: "source-thread",
    checkpointId: "source-checkpoint",
    label: "pre-mutation",
    repositorySnapshot: {
      protocolVersion: 1,
      snapshotId: repository.snapshotId,
      baselineHead: repository.head,
    },
    replayFingerprint: replay.replayFingerprint,
    effectLedgerDigest: replay.replayBinding.effectLedgerDigest,
  };
  const source = new FakeSession("source-session");
  source.appendEntry("pi-langgraph/checkpoint-link", sourceLink);
  const host = new RegisteredHost(source);
  const previousAgentRoot = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  langGraphExtension(host);
  return {
    context: { cwd: repositoryRoot, model: undefined, sessionManager: source },
    dataRoot,
    host,
    repositoryRoot,
    source,
    sourceLink,
    async cleanup() {
      if (previousAgentRoot === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentRoot;
      await rm(root, { recursive: true, force: true });
    },
  };
}

class FakeSession implements PiSessionReader {
  private readonly entries: PiSessionEntry[];
  private leafId: string | null;
  private nextId: number;

  constructor(
    private readonly sessionId: string,
    entries: readonly PiSessionEntry[] = [],
    leafId: string | null = entries.at(-1)?.id ?? null,
  ) {
    this.entries = entries.map((entry) => ({ ...entry }));
    this.leafId = leafId;
    this.nextId = entries.length + 1;
  }

  appendEntry(customType: string, data?: unknown): void {
    const id = `entry-${this.nextId++}`;
    this.entries.push({ type: "custom", id, parentId: this.leafId, customType, data });
    this.leafId = id;
  }

  getSessionId(): string { return this.sessionId; }
  getLeafId(): string | null { return this.leafId; }
  getEntry(id: string): PiSessionEntry | undefined { return this.entries.find((entry) => entry.id === id); }
  getEntries(): readonly PiSessionEntry[] { return this.entries.map((entry) => ({ ...entry })); }
}

class RegisteredHost {
  private readonly handlers = new Map<string, unknown>();
  private active: FakeSession;

  constructor(source: FakeSession) { this.active = source; }
  activate(session: FakeSession): void { this.active = session; }
  appendEntry(customType: string, data?: unknown): void { this.active.appendEntry(customType, data); }
  getActiveTools(): string[] { return []; }
  on(event: string, handler: unknown): void { this.handlers.set(event, handler); }
  registerTool(): void {}
  setLabel(): void {}

  emitBeforeFork(event: SessionBeforeForkEvent, context: PiLifecycleContext): Promise<unknown> {
    return this.invoke("session_before_fork", event, context);
  }
  emitBeforeTree(event: SessionBeforeTreeEvent, context: PiLifecycleContext): Promise<unknown> {
    return this.invoke("session_before_tree", event, context);
  }
  emitStart(event: SessionStartEvent, context: PiLifecycleContext): Promise<unknown> {
    return this.invoke("session_start", event, context);
  }
  emitTree(event: SessionTreeEvent, context: PiLifecycleContext): Promise<unknown> {
    return this.invoke("session_tree", event, context);
  }

  private async invoke(event: string, payload: unknown, context: PiLifecycleContext): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (typeof handler !== "function") throw new Error(`missing lifecycle handler: ${event}`);
    return Reflect.apply(handler, undefined, [payload, context]);
  }
}

function latestLink(session: FakeSession): SessionCheckpointLinkV1 {
  const entry = [...session.getEntries()].reverse().find((candidate) =>
    candidate.type === "custom" && candidate.customType === "pi-langgraph/checkpoint-link"
  );
  if (entry === undefined) throw new Error("destination checkpoint link is missing");
  return decodeSessionCheckpointLink(entry.data);
}

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

function beforeTreeEvent(targetId: string): SessionBeforeTreeEvent {
  return {
    type: "session_before_tree",
    preparation: {
      targetId,
      oldLeafId: targetId,
      commonAncestorId: targetId,
      entriesToSummarize: [],
      userWantsSummary: false,
    },
    signal: new AbortController().signal,
  };
}

function beforeForkEvent(entryId: string): SessionBeforeForkEvent {
  return { type: "session_before_fork", entryId, position: "at" };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

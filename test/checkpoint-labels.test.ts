import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkpointReplayMetadata,
  type ReplaySafetyContext,
} from "../src/persistence/checkpoint-thread-codec.ts";
import {
  fileNameForThread,
  isRecord,
  parseSerializedThread,
} from "../src/persistence/file-checkpoint-format.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { getWorkflowHistory } from "../src/workflow/runtime.ts";
import { ReplayCompatibilityError } from "../src/workflow/replay-compatibility.ts";

const replaySafety: ReplaySafetyContext = {
  bridgeProtocolVersion: 1,
  workflowVersion: 2,
  stateVersion: 3,
  workflowInput: { objective: "persist replay safety", approval: "before_changes" },
  toolModelConfigDigest: "b".repeat(64),
  effectLedgerDigest: "c".repeat(64),
};

test("restart preserves exact semantic labels and replay safety metadata", async () => {
  // Given: replay inputs and a repository snapshot bound to a durable thread.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-checkpoint-labels-"));
  const threadId = "semantic-restart";
  try {
    const saver = await FileCheckpointSaver.open(root);
    saver.bindRepositorySnapshot(threadId, {
      protocolVersion: 1,
      snapshotId: "a".repeat(64),
      head: "d".repeat(40),
    });
    saver.bindReplaySafety(threadId, replaySafety);
    const analyzed = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("checkpoint-analyzed", state("analyzed")),
      { source: "loop", step: 1, parents: {} },
      {},
    );
    await saver.put(
      analyzed,
      checkpoint("checkpoint-verified", state("verified")),
      { source: "loop", step: 2, parents: {} },
      {},
    );

    // When: a fresh saver reads the exact checkpoint and history.
    const reopened = await FileCheckpointSaver.open(root);
    const tuple = await reopened.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: "checkpoint-verified" },
    });
    const history = await getWorkflowHistory(reopened, threadId);
    const replay = checkpointReplayMetadata(tuple?.metadata);

    // Then: labels and every replay dependency survive with exact lineage.
    expect(history.map((entry) => [entry.checkpointId, entry.semanticLabels])).toEqual([
      ["checkpoint-verified", ["last-known-green"]],
      ["checkpoint-analyzed", ["post-discovery", "pre-mutation"]],
    ]);
    expect(replay?.replayBinding).toMatchObject({
      checkpoint: {
        threadId,
        checkpointId: "checkpoint-verified",
        lineage: ["checkpoint-analyzed", "checkpoint-verified"],
      },
      workflowInput: replaySafety.workflowInput,
      repositorySnapshot: {
        snapshotId: "a".repeat(64),
        baselineHead: "d".repeat(40),
      },
      toolModelConfigDigest: replaySafety.toolModelConfigDigest,
      effectLedgerDigest: replaySafety.effectLedgerDigest,
    });
    expect(replay?.replayFingerprint).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("thread deletion clears bound replay safety", async () => {
  // Given: replay inputs bound to a thread before it is deleted.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-delete-replay-"));
  const threadId = "deleted-replay-binding";
  try {
    const saver = await FileCheckpointSaver.open(root);
    saver.bindRepositorySnapshot(threadId, {
      protocolVersion: 1,
      snapshotId: "a".repeat(64),
      head: null,
    });
    saver.bindReplaySafety(threadId, replaySafety);
    await saver.deleteThread(threadId);

    // When: the same thread id is reused without rebinding.
    await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("checkpoint-reused", state("repaired")),
      { source: "input", step: -1, parents: {} },
      {},
    );
    const tuple = await saver.getTuple({ configurable: { thread_id: threadId } });
    const replay = checkpointReplayMetadata(tuple?.metadata);

    // Then: the derived label remains, but stale replay data is absent.
    expect(replay?.semanticLabels).toEqual(["post-repair"]);
    expect(replay?.replayBinding).toBeUndefined();
    expect(replay?.replayFingerprint).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("subgraph checkpoints remain unlabeled", async () => {
  // Given: a checkpoint stored in a nested graph namespace.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-subgraph-label-"));
  try {
    const saver = await FileCheckpointSaver.open(root);

    // When: the nested checkpoint is persisted.
    await saver.put(
      { configurable: { thread_id: "nested-label", checkpoint_ns: "change:core" } },
      checkpoint("nested-checkpoint", { phase: "analyzed" }),
      { source: "loop", step: 1, parents: {} },
      {},
    );
    const tuple = await saver.getTuple({
      configurable: {
        thread_id: "nested-label",
        checkpoint_ns: "change:core",
        checkpoint_id: "nested-checkpoint",
      },
    });

    // Then: root semantic labels are not projected onto the subgraph checkpoint.
    expect(checkpointReplayMetadata(tuple?.metadata)).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed replay metadata is typed-rejected and quarantined without harming a neighbor", async () => {
  // Given: one replay-bound checkpoint and one healthy neighboring thread.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-malformed-replay-"));
  const malformedThread = "malformed-replay";
  const healthyThread = "healthy-replay-neighbor";
  try {
    const saver = await FileCheckpointSaver.open(root);
    saver.bindRepositorySnapshot(malformedThread, {
      protocolVersion: 1,
      snapshotId: "a".repeat(64),
      head: null,
    });
    saver.bindReplaySafety(malformedThread, replaySafety);
    await saver.put(
      { configurable: { thread_id: malformedThread } },
      checkpoint("malformed-checkpoint", state("analyzed")),
      { source: "loop", step: 1, parents: {} },
      {},
    );
    await saver.put(
      { configurable: { thread_id: healthyThread } },
      checkpoint("healthy-checkpoint", state("analyzed")),
      { source: "loop", step: 1, parents: {} },
      {},
    );
    const path = join(root, fileNameForThread(malformedThread));
    const parsed = parseSerializedThread(await readFile(path, "utf8"), path);
    const entry = parsed.storage[""]?.["malformed-checkpoint"];
    if (entry === undefined) throw new Error("malformed replay fixture checkpoint is missing");
    const decoded: unknown = JSON.parse(Buffer.from(entry.metadata, "base64").toString("utf8"));
    if (!isRecord(decoded) || !isRecord(decoded.piLangGraph)) {
      throw new Error("malformed replay fixture metadata is missing");
    }
    const malformedMetadata = {
      ...decoded,
      piLangGraph: { ...decoded.piLangGraph, replayFingerprint: "not-a-digest" },
    };
    const storage = {
      ...parsed.storage,
      "": {
        ...parsed.storage[""],
        "malformed-checkpoint": {
          ...entry,
          metadata: Buffer.from(JSON.stringify(malformedMetadata)).toString("base64"),
        },
      },
    };
    await writeFile(path, `${JSON.stringify({
      version: parsed.version,
      threadId: parsed.threadId,
      storage,
      writes: parsed.writes,
      mutations: parsed.mutations,
    })}\n`);

    // When: the strict metadata boundary parses the malformed value and reopens storage.
    expect(checkpointReplayMetadata({ source: "loop", step: 1, parents: {} })).toBeUndefined();
    expect(() => checkpointReplayMetadata({
      piLangGraph: { version: 1, semanticLabels: ["analysis-ready"] },
    })).toThrow(ReplayCompatibilityError);
    expect(() => checkpointReplayMetadata(malformedMetadata)).toThrow(ReplayCompatibilityError);
    const reopened = await FileCheckpointSaver.open(root);

    // Then: only the malformed thread is quarantined.
    await expect(reopened.getTuple({ configurable: { thread_id: malformedThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    expect(await reopened.getTuple({ configurable: { thread_id: healthyThread } })).toBeDefined();
    expect(reopened.quarantinedFiles).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function checkpoint(id: string, channelValues: Record<string, unknown>) {
  return {
    v: 1,
    id,
    ts: new Date(0).toISOString(),
    channel_values: channelValues,
    channel_versions: {},
    versions_seen: {},
  };
}

function state(phase: "analyzed" | "verified" | "repaired"): Record<string, unknown> {
  const implementation = {
    kind: "implementation",
    summary: "changed",
    filesChanged: ["src/core.ts"],
    evidence: ["changed"],
    unresolvedRisks: [],
  };
  const repair = { ...implementation, kind: "repair", summary: "repaired" };
  return {
    objective: "Persist replay safety",
    pattern: "delivery",
    maxIterations: phase === "repaired" ? 1 : 0,
    approvalRequired: phase === "analyzed",
    discoveryRound: 1,
    workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
    acceptanceCriteria: ["tests pass"],
    findings: [],
    changes: phase === "analyzed" ? [] : phase === "repaired" ? [implementation, repair] : [implementation],
    verification: phase === "analyzed"
      ? undefined
      : { passed: true, summary: "green", checks: [{ name: "tests", passed: true, evidence: "exit 0" }] },
    diagnostic: phase === "repaired"
      ? { summary: "fixed", rootCauses: ["bug"], repairInstructions: ["repair"] }
      : undefined,
    iteration: phase === "repaired" ? 1 : 0,
    phase,
    status: phase === "analyzed" ? "awaiting_approval" : "running",
    summary: "",
    unresolvedRisks: [],
    trace: [],
  };
}

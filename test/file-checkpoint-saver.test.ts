import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";

test("quarantines a corrupt checkpoint without disabling healthy threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-corrupt-"));
  const directory = join(root, "checkpoints");
  const executor: TaskExecutor = {
    async execute(request) {
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "healthy", title: "Healthy", instruction: "Inspect healthy state" }],
          acceptanceCriteria: ["healthy state remains readable"],
        });
      }
      if (request.task.id === "specialist_healthy") {
        return JSON.stringify({ summary: "healthy", evidence: [], risks: [], discoveredWorkItems: [] });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "healthy review" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  try {
    const saver = await FileCheckpointSaver.open(directory);
    await runCodingWorkflow(
      { objective: "Review healthy state", workflow: "review" },
      executor,
      { threadId: "healthy-thread", checkpointer: saver, retainCheckpoint: true },
    );
    const corruptName = `${"0".repeat(64)}.checkpoint.json`;
    await writeFile(join(directory, corruptName), '{"version":1,"threadId":"broken"}', { mode: 0o600 });

    const reopened = await FileCheckpointSaver.open(directory);
    expect(await reopened.getTuple({ configurable: { thread_id: "healthy-thread" } })).toBeDefined();
    const files = await readdir(directory);
    expect(files).not.toContain(corruptName);
    expect(files.some((file) => file.startsWith(`${corruptName}.corrupt-`))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantines canonical base64 that is not a valid serialized checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-invalid-payload-"));
  const directory = join(root, "checkpoints");
  const threadId = "invalid-payload";
  const fileName = `${createHash("sha256").update(threadId).digest("hex")}.checkpoint.json`;

  try {
    const saver = await FileCheckpointSaver.open(directory);
    await saver.put(
      { configurable: { thread_id: threadId } },
      {
        v: 1,
        id: "checkpoint-1",
        ts: new Date(0).toISOString(),
        channel_values: {},
        channel_versions: {},
        versions_seen: {},
      },
      { source: "input", step: -1, parents: {} },
      {},
    );
    const document: unknown = JSON.parse(await readFile(join(directory, fileName), "utf8"));
    const checkpointEntry = firstCheckpointEntry(document);
    checkpointEntry.checkpoint = Buffer.from("not serializer data", "utf8").toString("base64");
    await writeFile(join(directory, fileName), `${JSON.stringify(document)}\n`, { mode: 0o600 });

    const reopened = await FileCheckpointSaver.open(directory);
    await expect(reopened.getTuple({ configurable: { thread_id: threadId } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantines oversized files and validly serialized workflow state outside semantic bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-bounded-checkpoint-"));
  const directory = join(root, "checkpoints");
  const semanticThread = "invalid-semantic-state";
  const oversizedThread = "oversized-state";
  const oversizedName = `${createHash("sha256").update(oversizedThread).digest("hex")}.checkpoint.json`;

  try {
    const saver = await FileCheckpointSaver.open(directory);
    await saver.put(
      { configurable: { thread_id: semanticThread } },
      {
        v: 1,
        id: "checkpoint-1",
        ts: new Date(0).toISOString(),
        channel_values: {
          objective: "Review repository",
          pattern: "review",
          maxIterations: 0,
          approvalRequired: false,
          discoveryRound: 0,
          workItems: Array.from({ length: 17 }, (_, index) => ({
            id: `item-${index}`,
            title: `Item ${index}`,
            instruction: "Inspect",
          })),
          acceptanceCriteria: ["bounded"],
          findings: [],
          changes: [],
          iteration: 0,
          phase: "discovered",
          status: "running",
          summary: "",
          unresolvedRisks: [],
          trace: [],
        },
        channel_versions: {},
        versions_seen: {},
      },
      { source: "input", step: -1, parents: {} },
      {},
    );
    await writeFile(join(directory, oversizedName), "x".repeat(9 * 1024 * 1024), { mode: 0o600 });

    const reopened = await FileCheckpointSaver.open(directory);
    await expect(reopened.getTuple({ configurable: { thread_id: semanticThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    await expect(reopened.getTuple({ configurable: { thread_id: oversizedThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    expect(reopened.quarantinedFiles.some((file) => file.error.includes("file exceeds"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function firstCheckpointEntry(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.storage)) throw new Error("missing checkpoint storage");
  const namespace = Object.values(value.storage)[0];
  if (!isRecord(namespace)) throw new Error("missing checkpoint namespace");
  const entry = Object.values(namespace)[0];
  if (!isRecord(entry)) throw new Error("missing checkpoint entry");
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

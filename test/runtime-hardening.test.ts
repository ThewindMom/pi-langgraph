import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { ProgressEvent, TaskExecutor } from "../src/types.ts";
import { passingEvidenceRunner } from "./helpers/evidence.ts";

function successfulOutput(taskId: string): string {
  if (taskId === "discover") {
    return JSON.stringify({
      workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
      acceptanceCriteria: ["tests pass"],
    });
  }
  if (taskId === "specialist_core") {
    return JSON.stringify({ summary: "found core", evidence: [], risks: [], discoveredWorkItems: [] });
  }
  if (taskId === "implement") {
    return JSON.stringify({
      summary: "implemented",
      filesChanged: ["src/core.ts"],
      evidence: ["changed core"],
      unresolvedRisks: [],
    });
  }
  if (taskId === "verify") {
    return JSON.stringify({
      passed: true,
      summary: "passed",
      checks: [{ name: "tests", passed: true, evidence: "exit 0" }],
    });
  }
  if (taskId === "synthesize") return JSON.stringify({ summary: "complete" });
  throw new Error(`unexpected task ${taskId}`);
}

test("a mutating worker receives an abort signal when its node timeout expires", async () => {
  let implementationCalls = 0;
  let aborts = 0;
  const executor: TaskExecutor = {
    async execute(request, signal) {
      if (request.task.id !== "implement") return successfulOutput(request.task.id);
      implementationCalls += 1;
      return new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborts += 1;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  };

  await expect(
    runCodingWorkflow(
      { objective: "Implement core" },
      executor,
      { threadId: "timeout-aborts-mutation", nodeTimeoutMs: 20, retainCheckpoint: true },
    ),
  ).rejects.toThrow("timed out after 20ms");
  expect(implementationCalls).toBe(1);
  expect(aborts).toBe(1);
});

test("terminal needs_attention checkpoints are retained and resume idempotently by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-needs-attention-"));
  const calls: string[] = [];
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      if (request.task.id === "verify") {
        return JSON.stringify({
          passed: false,
          summary: "failed",
          checks: [{ name: "tests", passed: false, evidence: "exit 1" }],
        });
      }
      return successfulOutput(request.task.id);
    },
  };

  try {
    const saver = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const result = await runCodingWorkflow(
      { objective: "Implement core", maxIterations: 0 },
      executor,
      { checkpointer: saver, threadId: "retained-failure" },
    );
    expect(result.status).toBe("needs_attention");
    expect(await readdir(join(root, "checkpoints"))).toHaveLength(1);

    const callsBeforeResume = [...calls];
    const resumed = await resumeCodingWorkflow("retained-failure", executor, { checkpointer: saver });
    expect(resumed.status).toBe("needs_attention");
    expect(calls).toEqual(callsBeforeResume);
    expect(await readdir(join(root, "checkpoints"))).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a corrupt checkpoint is isolated to its hashed thread while unrelated state still loads", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-corrupt-"));
  const checkpointDirectory = join(root, "checkpoints");
  const corruptThread = "corrupt-thread";
  const corruptName = `${createHash("sha256").update(corruptThread).digest("hex")}.checkpoint.json`;

  try {
    const saver = await FileCheckpointSaver.open(checkpointDirectory);
    await saver.put(
      { configurable: { thread_id: "healthy-thread" } },
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
    await writeFile(join(checkpointDirectory, corruptName), "{not-json\n", { mode: 0o600 });

    const reopened = await FileCheckpointSaver.open(checkpointDirectory);
    expect(await reopened.getTuple({ configurable: { thread_id: "healthy-thread" } })).toBeDefined();
    await expect(reopened.getTuple({ configurable: { thread_id: corruptThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow progress never reports a completed count above its dynamically observed total", async () => {
  const updates: ProgressEvent[] = [];
  const executor: TaskExecutor = { execute: async (request) => successfulOutput(request.task.id) };
  const result = await runCodingWorkflow(
    { objective: "Implement core" },
    executor,
    { threadId: "progress-invariant", retainCheckpoint: true, evidenceRunner: passingEvidenceRunner(), onProgress: (update) => updates.push(update) },
  );

  expect(result.status).toBe("completed");
  expect(updates.length).toBeGreaterThan(0);
  expect(updates.every((update) => update.completed <= update.total)).toBe(true);
  expect(updates.at(-1)?.completed).toBe(updates.at(-1)?.total);
});

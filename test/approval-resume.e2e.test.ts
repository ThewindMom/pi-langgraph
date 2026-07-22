import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { getWorkflowHistory, resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";

test("pauses before mutation and resumes only with explicit approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-approval-"));
  const calls: string[] = [];
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
          acceptanceCriteria: ["tests pass"],
        });
      }
      if (request.task.id === "specialist_core") {
        return JSON.stringify({ summary: "located core", evidence: [], risks: [] });
      }
      if (request.task.id === "implement") {
        return JSON.stringify({
          summary: "implemented",
          filesChanged: ["src/core.ts"],
          evidence: ["changed core"],
          unresolvedRisks: [],
        });
      }
      if (request.task.id === "verify") {
        return JSON.stringify({
          passed: true,
          summary: "passed",
          checks: [{ name: "tests", passed: true, evidence: "exit 0" }],
        });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "approved and verified" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  try {
    const saver = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const paused = await runCodingWorkflow(
      { objective: "Implement core", approval: "before_changes" },
      executor,
      { checkpointer: saver, threadId: "approval-thread", retainCheckpoint: true },
    );
    expect(paused.status).toBe("awaiting_approval");
    expect(calls).toEqual(["discover", "specialist_core"]);

    const stillPaused = await resumeCodingWorkflow("approval-thread", executor, {
      checkpointer: saver,
      retainCheckpoint: true,
    });
    expect(stillPaused.status).toBe("awaiting_approval");
    expect(calls).toEqual(["discover", "specialist_core"]);

    const completed = await resumeCodingWorkflow("approval-thread", executor, {
      checkpointer: saver,
      approved: true,
      retainCheckpoint: true,
    });
    expect(completed.status).toBe("completed");
    expect(calls).toEqual(["discover", "specialist_core", "implement", "verify", "synthesize"]);

    const history = await getWorkflowHistory(saver, "approval-thread");
    expect(history.length).toBeGreaterThan(3);
    expect(history.some((entry) => entry.phase === "analyzed")).toBe(true);
    expect(history.some((entry) => entry.phase === "synthesized")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

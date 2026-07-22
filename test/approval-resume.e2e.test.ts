import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { getWorkflowHistory, resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import { decisionForInterrupt } from "../src/workflow/risk-policy.ts";
import type { TaskExecutor } from "../src/types.ts";
import { passingEvidenceRunner } from "./helpers/evidence.ts";

test("pauses before mutation and resumes only with explicit approval", async () => {
  // Given: a file-backed workflow paused before its first mutation.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-approval-"));
  const calls: string[] = [];
  const evidenceRunner = passingEvidenceRunner();
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
      { checkpointer: saver, threadId: "approval-thread", retainCheckpoint: true, evidenceRunner },
    );
    expect(paused.status).toBe("awaiting_approval");
    expect(calls).toEqual(["discover", "specialist_core"]);
    if (paused.status !== "awaiting_approval") throw new Error("missing persisted interrupt");

    // When: a new saver instance simulates process restart and first resumes without a decision.
    const restartedSaver = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const stillPaused = await resumeCodingWorkflow("approval-thread", executor, {
      checkpointer: restartedSaver,
      retainCheckpoint: true,
      evidenceRunner,
    });
    expect(stillPaused.status).toBe("awaiting_approval");
    expect(calls).toEqual(["discover", "specialist_core"]);

    // Then: the exact persisted approval mutates once, and replay is rejected before another Command.
    const decision = decisionForInterrupt(paused.interrupt, "approve");
    const completed = await resumeCodingWorkflow("approval-thread", executor, {
      checkpointer: restartedSaver,
      decision,
      retainCheckpoint: true,
      evidenceRunner,
    });
    expect(completed.status).toBe("completed");
    expect(calls).toEqual(["discover", "specialist_core", "implement", "verify", "synthesize"]);
    await expect(resumeCodingWorkflow("approval-thread", executor, {
      checkpointer: restartedSaver,
      decision,
      retainCheckpoint: true,
      evidenceRunner,
    })).rejects.toThrow("no pending approval");
    expect(calls).toEqual(["discover", "specialist_core", "implement", "verify", "synthesize"]);

    // The boolean compatibility path projects the current persisted decision exactly.
    const compatibilityPaused = await runCodingWorkflow(
      { objective: "Implement core", approval: "before_changes" },
      executor,
      { checkpointer: restartedSaver, threadId: "approval-boolean", retainCheckpoint: true, evidenceRunner },
    );
    expect(compatibilityPaused.status).toBe("awaiting_approval");
    const compatibilityCompleted = await resumeCodingWorkflow("approval-boolean", executor, {
      checkpointer: restartedSaver,
      approved: true,
      retainCheckpoint: true,
      evidenceRunner,
    });
    expect(compatibilityCompleted.status).toBe("completed");

    const history = await getWorkflowHistory(restartedSaver, "approval-thread");
    expect(history.length).toBeGreaterThan(3);
    expect(history.some((entry) => entry.phase === "analyzed")).toBe(true);
    expect(history.some((entry) => entry.phase === "synthesized")).toBe(true);

    const rejectionPaused = await runCodingWorkflow(
      { objective: "Reject core", approval: "before_changes" },
      executor,
      { checkpointer: restartedSaver, threadId: "approval-rejected", retainCheckpoint: true, evidenceRunner },
    );
    if (rejectionPaused.status !== "awaiting_approval") throw new Error("rejection workflow did not pause");
    const rejected = await resumeCodingWorkflow("approval-rejected", executor, {
      checkpointer: restartedSaver,
      decision: decisionForInterrupt(rejectionPaused.interrupt, "reject"),
      retainCheckpoint: true,
      evidenceRunner,
    });
    expect(rejected).toMatchObject({
      status: "needs_attention",
      summary: "Planned change aggregate was rejected at its approval boundary.",
    });
    const reopenedAfterRejection = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const rejectedHistory = await getWorkflowHistory(reopenedAfterRejection, "approval-rejected");
    expect(rejectedHistory.some((entry) => entry.phase === "escalated")).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

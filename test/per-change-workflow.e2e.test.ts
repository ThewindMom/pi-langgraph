import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { HostEvidence } from "../src/evidence/types.ts";
import type { TaskExecutor } from "../src/types.ts";

test("completed dependency changes survive restart while only the failed change is repaired", async () => {
  // Given: two dependent changes whose second host check fails once and whose repair is interrupted.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-per-change-"));
  const calls: string[] = [];
  let repairInterrupted = true;
  const checkCalls = new Map<string, number>();
  const evidenceRunner = {
    async defaultIntegrationScripts(): Promise<readonly string[]> {
      return ["check:a", "check:b"];
    },
    async runPackageScript(script: string): Promise<HostEvidence> {
      const count = (checkCalls.get(script) ?? 0) + 1;
      checkCalls.set(script, count);
      const passed = script !== "check:b" || count > 1;
      const artifact = { digest: "a".repeat(64), byteCount: 0, truncated: false };
      return {
        script,
        packageManager: "bun",
        exitCode: passed ? 0 : 1,
        signal: null,
        durationMs: 1,
        stdout: artifact,
        stderr: artifact,
        passed,
      };
    },
  };
  const executor: TaskExecutor = {
    async execute({ task }) {
      calls.push(task.id);
      if (task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
          acceptanceCriteria: ["integration passes"],
          executionPlan: {
            version: 1,
            planId: "plan-restart",
            revision: 1,
            changes: [
              plannedChange("a", [], "check:a"),
              plannedChange("b", ["a"], "check:b"),
            ],
          },
        });
      }
      if (task.id === "specialist_core") {
        return JSON.stringify({ summary: "found core", evidence: [], risks: [], discoveredWorkItems: [] });
      }
      if (task.id === "implement_a" || task.id === "implement_b") return changeOutput(task.id);
      if (task.id === "repair_b") {
        if (repairInterrupted) throw new Error("simulated restart during repair");
        return changeOutput(task.id);
      }
      if (task.id === "verify") {
        return JSON.stringify({
          passed: true,
          summary: "integration passed",
          checks: [{ name: "integration", passed: true, evidence: "exit 0" }],
        });
      }
      if (task.id === "synthesize") return JSON.stringify({ summary: "all planned changes verified" });
      throw new Error(`unexpected task ${task.id}`);
    },
  };

  try {
    const directory = join(root, "checkpoints");
    const firstSaver = await FileCheckpointSaver.open(directory);

    // When: the workflow stops during the failed change's repair and is resumed from disk.
    await expect(runCodingWorkflow(
      { objective: "Implement dependent changes" },
      executor,
      {
        checkpointer: firstSaver,
        evidenceRunner,
        threadId: "per-change-restart",
        retainCheckpoint: true,
      },
    )).rejects.toThrow("simulated restart during repair");
    repairInterrupted = false;
    const reopened = await FileCheckpointSaver.open(directory);
    const result = await resumeCodingWorkflow("per-change-restart", executor, {
      checkpointer: reopened,
      evidenceRunner,
      retainCheckpoint: true,
    });

    // Then: change A is preserved, B alone is repaired, and final integration gates completion.
    expect(result.status).toBe("completed");
    if (result.status === "awaiting_approval") throw new Error("workflow remained paused");
    expect(calls.filter((id) => id === "implement_a")).toHaveLength(1);
    expect(calls.filter((id) => id === "implement_b")).toHaveLength(1);
    expect(calls.filter((id) => id === "repair_b")).toHaveLength(1);
    expect(calls).not.toContain("repair_a");
    expect(checkCalls.get("check:a")).toBe(2);
    expect(checkCalls.get("check:b")).toBe(3);
    expect(result.changeResults.filter((entry) => entry.changeId === "a").at(-1)?.status).toBe("passed");
    expect(result.changeResults.filter((entry) => entry.changeId === "b").at(-1)?.status).toBe("passed");
    expect(result.verification?.passed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("defers a shared integration script until every independent scoped change is applied", async () => {
  const calls: string[] = [];
  let evidenceCalls = 0;
  const evidenceRunner = {
    async defaultIntegrationScripts(): Promise<readonly string[]> { return ["test"]; },
    async runPackageScript(script: string): Promise<HostEvidence> {
      evidenceCalls += 1;
      const artifact = { digest: "b".repeat(64), byteCount: 0, truncated: false };
      return { script, packageManager: "bun", exitCode: 0, signal: null, durationMs: 1, stdout: artifact, stderr: artifact, passed: true };
    },
  };
  const executor: TaskExecutor = {
    async execute({ task }) {
      calls.push(task.id);
      if (task.id === "discover") return JSON.stringify({
        workItems: [{ id: "scope", title: "Scope", instruction: "Inspect both scopes" }],
        acceptanceCriteria: ["integration passes"],
        executionPlan: {
          version: 1,
          planId: "shared-integration",
          revision: 1,
          changes: [plannedChange("a", [], "test"), plannedChange("b", [], "test")],
        },
      });
      if (task.id === "specialist_scope") return JSON.stringify({ summary: "found", evidence: [], risks: [], discoveredWorkItems: [] });
      if (task.id === "implement_a" || task.id === "implement_b") return changeOutput(task.id);
      if (task.id === "verify") return JSON.stringify({ passed: true, summary: "passed", checks: [{ name: "test", passed: true, evidence: "exit 0" }] });
      if (task.id === "synthesize") return JSON.stringify({ summary: "both scopes completed" });
      throw new Error(`unexpected task ${task.id}`);
    },
  };

  const result = await runCodingWorkflow({ objective: "Implement both scopes" }, executor, {
    threadId: "shared-integration",
    retainCheckpoint: true,
    evidenceRunner,
  });

  expect(result.status).toBe("completed");
  expect(calls.filter((id) => id.startsWith("implement_"))).toEqual(["implement_a", "implement_b"]);
  expect(calls.some((id) => id.startsWith("repair_"))).toBe(false);
  expect(evidenceCalls).toBe(2);
  expect(result.unresolvedRisks).toEqual([]);
});

function plannedChange(changeId: string, dependsOn: readonly string[], script: string) {
  return {
    changeId,
    title: `Change ${changeId}`,
    instruction: `Implement ${changeId}`,
    dependsOn,
    scope: { files: [`src/${changeId}.ts`] },
    risk: { level: "low", reasons: [] },
    acceptanceChecks: [{ kind: "package_script", script }],
    status: "pending",
  };
}

function changeOutput(summary: string): string {
  return JSON.stringify({
    summary,
    filesChanged: [`src/${summary.at(-1)}.ts`],
    evidence: [summary],
    unresolvedRisks: [],
  });
}

import { expect, test } from "bun:test";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { HostEvidence } from "../src/evidence/types.ts";
import type { TaskExecutor } from "../src/types.ts";
import type { WorkflowEvent } from "../src/workflow/stream-events.ts";

test("workflow stream projects causal LangGraph payloads with stable bounded identity", async () => {
  // Given: a planned change that produces host evidence inside a subgraph.
  const events: WorkflowEvent[] = [];
  const stdout = { digest: "a".repeat(64), byteCount: 12, truncated: false } as const;
  const stderr = { digest: "b".repeat(64), byteCount: 0, truncated: false } as const;
  const executor: TaskExecutor = {
    async execute({ task }) {
      if (task.id === "discover") return JSON.stringify({
        workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
        acceptanceCriteria: ["verified"],
        executionPlan: {
          version: 1,
          planId: "stream-plan",
          revision: 1,
          changes: [{
            changeId: "core-change",
            title: "Core change",
            instruction: "Implement core",
            dependsOn: [],
            scope: { files: ["src/core.ts"] },
            risk: { level: "low", reasons: [] },
            acceptanceChecks: [{ kind: "package_script", script: "test" }],
            status: "pending",
          }],
        },
      });
      if (task.id.startsWith("specialist_")) return JSON.stringify({ summary: "found", evidence: [], risks: [] });
      if (task.id.startsWith("implement")) return JSON.stringify({ summary: "done", filesChanged: ["src/core.ts"], evidence: [], unresolvedRisks: [] });
      if (task.id === "verify") return JSON.stringify({ passed: true, summary: "ok", checks: [{ name: "test", passed: true, evidence: "exit 0" }] });
      return JSON.stringify({ summary: "complete" });
    },
  };
  const evidenceRunner = {
    async runPackageScript(script: string): Promise<HostEvidence> {
      return { script, packageManager: "bun", exitCode: 0, signal: null, durationMs: 1, stdout, stderr, passed: true };
    },
  };

  // When: the complete root graph and nested change graph are streamed.
  await runCodingWorkflow({ objective: "Implement core", workflow: "delivery" }, executor, {
    threadId: "stream-contract",
    retainCheckpoint: true,
    evidenceRunner,
    onEvent: (event) => events.push(event),
  });

  // Then: every event shares one run identity and the global sequence preserves causal order.
  expect(events.length).toBeGreaterThan(0);
  expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
  const runIds = new Set(events.map((event) => "runId" in event ? event.runId : undefined));
  expect(runIds.size).toBe(1);
  expect(runIds.has(undefined)).toBe(false);
  expect(events.every((event) => event.threadId === "stream-contract" && event.namespace.length > 0)).toBe(true);
  expect(events.every((event) => JSON.stringify(event).length <= 16 * 1024)).toBe(true);

  const classifyUpdate = events.find((event) => event.kind === "update" && "nodeId" in event && event.nodeId === "classify");
  expect(classifyUpdate).toBeDefined();
  expect(classifyUpdate === undefined ? undefined : JSON.parse(classifyUpdate.detail)).toMatchObject({ phase: "classified" });
  expect(events.some((event) => event.kind === "task" && "taskId" in event && "nodeId" in event &&
    typeof event.taskId === "string" && event.nodeId === "discover")).toBe(true);
  expect(events.some((event) => event.kind === "checkpoint" && "checkpointId" in event &&
    typeof event.checkpointId === "string")).toBe(true);
  expect(events.some((event) => event.kind === "checkpoint" && "semanticLabels" in event &&
    event.semanticLabels.includes("post-discovery") && event.semanticLabels.includes("pre-mutation"))).toBe(true);
  expect(events.some((event) => event.kind === "checkpoint" && "semanticLabels" in event &&
    event.semanticLabels.includes("last-known-green"))).toBe(true);

  const parentChangeTask = events.findIndex((event) => event.kind === "task" && "nodeId" in event && event.nodeId === "change");
  const nestedChange = events.findIndex((event) => event.namespace.startsWith("change:"));
  expect(parentChangeTask).toBeGreaterThanOrEqual(0);
  expect(nestedChange).toBeGreaterThan(parentChangeTask);
  expect(events.some((event) => "changeId" in event && event.changeId === "core-change")).toBe(true);
  expect(events.some((event) => "artifactRefs" in event && Array.isArray(event.artifactRefs) &&
    event.artifactRefs.some((ref) => ref.digest === stdout.digest))).toBe(true);
  expect(events.filter((event) => event.kind === "terminal")).toHaveLength(1);
  expect(events.at(-1)?.kind).toBe("terminal");
});

import { expect, test } from "bun:test";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";

test("specialist discoveries trigger a bounded second dynamic Send wave", async () => {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  let childrenStarted = 0;
  let release: () => void = () => undefined;
  const bothChildrenStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "architecture", title: "Architecture", instruction: "Inspect architecture" }],
          acceptanceCriteria: ["all discovered subsystems are covered"],
        });
      }
      if (request.task.id === "specialist_architecture") {
        return JSON.stringify({
          summary: "discovered two independent subsystems",
          evidence: [],
          risks: [],
          discoveredWorkItems: [
            { id: "frontend", title: "Frontend", instruction: "Inspect frontend subsystem" },
            { id: "backend", title: "Backend", instruction: "Inspect backend subsystem" },
          ],
        });
      }
      if (request.task.id === "specialist_frontend" || request.task.id === "specialist_backend") {
        active += 1;
        peak = Math.max(peak, active);
        childrenStarted += 1;
        if (childrenStarted === 2) release();
        await bothChildrenStarted;
        active -= 1;
        return JSON.stringify({ summary: request.task.id, evidence: [], risks: [], discoveredWorkItems: [] });
      }
      if (request.task.id === "implement") {
        return JSON.stringify({
          summary: "implemented both subsystems",
          filesChanged: ["src/frontend.ts", "src/backend.ts"],
          evidence: ["integrated both"],
          unresolvedRisks: [],
        });
      }
      if (request.task.id === "verify") {
        return JSON.stringify({
          passed: true,
          summary: "passed",
          checks: [{ name: "integration", passed: true, evidence: "exit 0" }],
        });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "replanned, implemented, verified" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  const result = await runCodingWorkflow(
    { objective: "Implement the application across all discovered subsystems" },
    executor,
    { threadId: "dynamic-replan", retainCheckpoint: true },
  );

  expect(result.status).toBe("completed");
  expect(peak).toBe(2);
  expect(result.workItems.map((item) => item.id)).toEqual(["architecture", "frontend", "backend"]);
  expect(result.trace.map((event) => event.node)).toEqual([
    "classify",
    "discover",
    "specialist",
    "replan",
    "specialist",
    "specialist",
    "implement",
    "verify",
    "synthesize",
  ]);
  expect(calls.filter((id) => id.startsWith("specialist_"))).toHaveLength(3);
});

test("valid follow-up proposals are selected deterministically within the global work-item cap", async () => {
  const initialIds = ["alpha", "beta", "gamma", "delta"];
  const calls: string[] = [];
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: initialIds.map((id) => ({ id, title: id, instruction: `Inspect ${id}` })),
          acceptanceCriteria: ["review is bounded"],
        });
      }
      if (request.task.id.startsWith("specialist_")) {
        const id = request.task.id.slice("specialist_".length);
        const discoveredWorkItems = initialIds.includes(id)
          ? Array.from({ length: 4 }, (_, index) => ({
              id: `${id}-${index + 1}`,
              title: `${id} ${index + 1}`,
              instruction: `Inspect ${id} follow-up ${index + 1}`,
            }))
          : [];
        return JSON.stringify({ summary: id, evidence: [], risks: [], discoveredWorkItems });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "bounded review complete" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  const result = await runCodingWorkflow(
    { objective: "Review the repository architecture", workflow: "review" },
    executor,
    { threadId: "bounded-valid-proposals", retainCheckpoint: true },
  );

  expect(result.status).toBe("completed");
  expect(result.workItems).toHaveLength(16);
  expect(result.workItems.map((item) => item.id)).toEqual([
    ...initialIds,
    "alpha-1",
    "alpha-2",
    "alpha-3",
    "alpha-4",
    "beta-1",
    "beta-2",
    "beta-3",
    "beta-4",
    "gamma-1",
    "gamma-2",
    "gamma-3",
    "gamma-4",
  ]);
  expect(calls.filter((id) => id.startsWith("specialist_"))).toHaveLength(16);
});

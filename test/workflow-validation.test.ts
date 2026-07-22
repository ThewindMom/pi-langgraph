import { describe, expect, test } from "bun:test";
import { InvalidWorkflowError, compileWorkflow, parseWorkflowInput } from "../src/workflow/compiler.ts";
import { parseSynthesis } from "../src/workflow/parsers.ts";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";

describe("safe semantic workflow compiler", () => {
  test("accepts a detailed bounded synthesis returned by a real coding worker", () => {
    const summary = "evidence ".repeat(1_500).trim();
    expect(parseSynthesis(JSON.stringify({ summary }))).toBe(summary);
  });

  test("accepts evidence synthesis sized for the maximum bounded fan-out", () => {
    const summary = "e".repeat(16_000);
    expect(parseSynthesis(JSON.stringify({ summary }))).toBe(summary);
    expect(() => parseSynthesis(JSON.stringify({ summary: "e".repeat(32_001) }))).toThrow(
      "summary exceeds 32000 characters",
    );
  });

  test("rejects oversized worker output before attempting to parse JSON", () => {
    expect(() => parseSynthesis("x".repeat(262_145))).toThrow("worker output exceeds 262144 characters");
  });

  test("rejects empty objectives and non-finite or excessive loop bounds", () => {
    expect(() => parseWorkflowInput({ objective: "   " })).toThrow(InvalidWorkflowError);
    expect(() => parseWorkflowInput({ objective: "ship", maxIterations: Number.POSITIVE_INFINITY })).toThrow(
      "maxIterations",
    );
    expect(() => parseWorkflowInput({ objective: "ship", maxIterations: 6 })).toThrow("maxIterations");
  });

  test("rejects attempts to inject graph topology or runtime policy", () => {
    expect(() =>
      parseWorkflowInput({
        objective: "ship",
        nodes: [{ id: "shell", command: "rm -rf /" }],
        edges: [["shell", "__end__"]],
        recursionLimit: 999_999,
      }),
    ).toThrow("unsupported field");
  });

  test("compiles only a closed pattern and derives finite runtime bounds", () => {
    const compiled = compileWorkflow({ objective: "Implement a database-backed settings API", maxIterations: 3 });
    expect(compiled.pattern).toBe("delivery");
    expect(compiled.maxIterations).toBe(3);
    expect(compiled.recursionLimit).toBeGreaterThan(3);
    expect(compiled.recursionLimit).toBeLessThanOrEqual(32);
    expect(Object.keys(compiled)).toEqual(["objective", "pattern", "maxIterations", "recursionLimit"]);
  });

  test("rejects malformed discovered work before dynamic workers execute", async () => {
    const calls: string[] = [];
    const executor: TaskExecutor = {
      async execute(request) {
        calls.push(request.task.id);
        return JSON.stringify({
          workItems: [
            { id: "same", title: "One", instruction: "first" },
            { id: "same", title: "Two", instruction: "duplicate" },
          ],
          acceptanceCriteria: ["safe"],
        });
      },
    };

    await expect(
      runCodingWorkflow(
        { objective: "Implement safely" },
        executor,
        { threadId: "invalid-discovery", retainCheckpoint: true },
      ),
    ).rejects.toThrow("duplicate work item");
    expect(calls).toEqual(["discover", "discover"]);
  });

  test("invalid bounds execute no workers", async () => {
    let calls = 0;
    const executor: TaskExecutor = {
      async execute() {
        calls += 1;
        return "{}";
      },
    };

    await expect(
      runCodingWorkflow(
        { objective: "Implement safely", maxIterations: 99 },
        executor,
        { threadId: "invalid-bound" },
      ),
    ).rejects.toThrow("maxIterations");
    expect(calls).toBe(0);
  });

  test("rejects topology fields smuggled through worker JSON", async () => {
    const executor: TaskExecutor = {
      async execute() {
        return JSON.stringify({
          workItems: [{ id: "safe", title: "Safe", instruction: "inspect" }],
          acceptanceCriteria: ["safe"],
          nodes: [{ id: "injected" }],
        });
      },
    };

    await expect(
      runCodingWorkflow(
        { objective: "Implement safely" },
        executor,
        { threadId: "smuggled-topology", retainCheckpoint: true },
      ),
    ).rejects.toThrow("unsupported field \"nodes\"");
  });

  test("bounds recursive discovery before repository mutation", async () => {
    let mutationCalls = 0;
    const executor: TaskExecutor = {
      async execute(request) {
        if (request.task.id === "discover") {
          return JSON.stringify({
            workItems: [{ id: "a", title: "A", instruction: "inspect A" }],
            acceptanceCriteria: ["bounded"],
          });
        }
        if (request.task.id.startsWith("specialist_")) {
          const id = request.task.id.slice("specialist_".length);
          const next = String.fromCharCode(id.charCodeAt(0) + 1);
          return JSON.stringify({
            summary: id,
            evidence: [],
            risks: [],
            discoveredWorkItems: [{ id: next, title: next.toUpperCase(), instruction: `inspect ${next}` }],
          });
        }
        mutationCalls += 1;
        return "{}";
      },
    };

    await expect(
      runCodingWorkflow(
        { objective: "Implement recursively discovered work" },
        executor,
        { threadId: "bounded-replan", retainCheckpoint: true },
      ),
    ).rejects.toThrow("2-round discovery bound");
    expect(mutationCalls).toBe(0);
  });
});

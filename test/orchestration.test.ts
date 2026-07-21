import { describe, expect, test } from "bun:test";
import { runOrchestration } from "../src/graph.ts";
import { InvalidPlanError, validatePlan } from "../src/plan.ts";
import type { ExecutionRequest, TaskExecutor } from "../src/types.ts";

function executor(run: (request: ExecutionRequest, signal?: AbortSignal) => Promise<string>): TaskExecutor {
  return { execute: run };
}

describe("plan validation", () => {
  test("rejects cyclic dependencies before executing", () => {
    expect(() =>
      validatePlan({
        objective: "cycle",
        tasks: [
          { id: "a", prompt: "A", dependsOn: ["b"] },
          { id: "b", prompt: "B", dependsOn: ["a"] },
        ],
      }),
    ).toThrow(InvalidPlanError);
  });

  test("rejects duplicate and unknown dependency ids", () => {
    expect(() =>
      validatePlan({
        objective: "invalid",
        tasks: [
          { id: "a", prompt: "A" },
          { id: "a", prompt: "Again", dependsOn: ["missing"] },
        ],
      }),
    ).toThrow("duplicate task id");
  });
});

describe("LangGraph orchestration", () => {
  test("fans out independent tasks and joins their results", async () => {
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    let started = 0;
    let releaseBoth: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const result = await runOrchestration(
      {
        objective: "parallel research then synthesis",
        tasks: [
          { id: "left", prompt: "research left" },
          { id: "right", prompt: "research right" },
          { id: "join", prompt: "combine", dependsOn: ["left", "right"] },
        ],
      },
      executor(async (request) => {
        seen.push(request.task.id);
        if (request.task.id === "join") {
          expect(request.dependencyResults.map((item) => item.id).sort()).toEqual(["left", "right"]);
          return request.dependencyResults.map((item) => item.output).join("+");
        }
        active += 1;
        peak = Math.max(peak, active);
        started += 1;
        if (started === 2) releaseBoth();
        await bothStarted;
        active -= 1;
        return request.task.id.toUpperCase();
      }),
    );

    expect(peak).toBe(2);
    expect(seen.at(-1)).toBe("join");
    expect(result.status).toBe("completed");
    expect(result.results.map((item) => [item.id, item.output])).toEqual([
      ["left", "LEFT"],
      ["right", "RIGHT"],
      ["join", "LEFT+RIGHT"],
    ]);
  });

  test("continue policy preserves failures for downstream tasks", async () => {
    const result = await runOrchestration(
      {
        objective: "recover",
        failurePolicy: "continue",
        tasks: [
          { id: "broken", prompt: "fail" },
          { id: "recover", prompt: "recover", dependsOn: ["broken"] },
        ],
      },
      executor(async (request) => {
        if (request.task.id === "broken") throw new Error("expected failure");
        expect(request.dependencyResults[0]?.error).toBe("expected failure");
        return "recovered";
      }),
    );

    expect(result.status).toBe("completed_with_errors");
    expect(result.results.map((item) => item.status)).toEqual(["failed", "completed"]);
  });

  test("fail-fast rejects and forwards cancellation", async () => {
    const controller = new AbortController();
    const running = runOrchestration(
      { objective: "cancel", tasks: [{ id: "worker", prompt: "wait" }] },
      executor(async (_request, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return "unreachable";
      }),
      { signal: controller.signal },
    );
    controller.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow("cancelled");
  });
});

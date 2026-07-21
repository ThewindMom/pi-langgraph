import { describe, expect, test } from "bun:test";
import { buildTaskPrompt, createTaskExecutor } from "../src/executors.ts";
import type { CompatibleExtensionAPI, ExecutionRequest } from "../src/types.ts";

const request: ExecutionRequest = {
  objective: "ship",
  task: { id: "review", prompt: "Review the implementation", dependsOn: ["build"] },
  dependencyResults: [
    {
      id: "build",
      status: "completed",
      output: "built",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
    },
  ],
};

describe("task executors", () => {
  test("uses the native task tool through the host execution pipeline", async () => {
    const calls: Array<{ name: string; params: unknown }> = [];
    const pi = {
      getActiveTools: () => ["task", "langgraph_orchestrate"],
      executeTool: async (name: string, params: unknown) => {
        calls.push({ name, params });
        return { content: [{ type: "text" as const, text: "reviewed" }], details: { status: "completed" } };
      },
    } as unknown as CompatibleExtensionAPI;

    const output = await createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(request);

    expect(output).toBe("reviewed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("task");
    expect(calls[0]?.params).toMatchObject({ name: "review", run_in_background: false });
  });

  test("selects the SDK fallback when Senpi's task tool is inactive", () => {
    const pi = {
      getActiveTools: () => ["langgraph_orchestrate"],
      executeTool: async () => ({ content: [], details: {} }),
    } as unknown as CompatibleExtensionAPI;

    expect(() => createTaskExecutor(pi, { cwd: "/tmp", model: undefined })).not.toThrow();
  });

  test("marks native failed results as worker errors", async () => {
    const pi = {
      getActiveTools: () => ["task"],
      executeTool: async () => ({
        content: [{ type: "text" as const, text: "worker crashed" }],
        details: { status: "failed" },
      }),
    } as unknown as CompatibleExtensionAPI;

    await expect(createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(request)).rejects.toThrow(
      "worker crashed",
    );
  });
});

test("worker prompt carries dependency outputs without expanding scope", () => {
  const prompt = buildTaskPrompt(request);
  expect(prompt).toContain("Overall objective: ship");
  expect(prompt).toContain('<dependency id="build" status="completed">\nbuilt\n</dependency>');
  expect(prompt).toContain("Complete only this task");
});

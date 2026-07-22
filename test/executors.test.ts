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
    const pi: CompatibleExtensionAPI = {
      getActiveTools: () => ["task", "langgraph_orchestrate"],
      executeTool: async (name: string, params: unknown) => {
        calls.push({ name, params });
        return { content: [{ type: "text" as const, text: "reviewed" }], details: { status: "completed" } };
      },
    };

    const output = await createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(request);

    expect(output).toBe("reviewed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("task");
    expect(calls[0]?.params).toMatchObject({ name: "review", run_in_background: false });
  });

  test("selects the SDK fallback when Senpi's task tool is inactive", () => {
    const pi: CompatibleExtensionAPI = {
      getActiveTools: () => ["langgraph_orchestrate"],
      executeTool: async () => ({ content: [], details: {} }),
    };

    expect(() => createTaskExecutor(pi, { cwd: "/tmp", model: undefined })).not.toThrow();
  });

  test("marks native failed results as worker errors", async () => {
    const pi: CompatibleExtensionAPI = {
      getActiveTools: () => ["task"],
      executeTool: async () => ({
        content: [{ type: "text" as const, text: "worker crashed" }],
        details: { status: "failed" },
      }),
    };

    await expect(createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(request)).rejects.toThrow(
      "worker crashed",
    );
  });

  test("rejects unknown native statuses instead of treating them as success", async () => {
    const pi: CompatibleExtensionAPI = {
      getActiveTools: () => ["task"],
      executeTool: async () => ({
        content: [{ type: "text" as const, text: "ambiguous" }],
        details: { status: "mystery" },
      }),
    };

    await expect(createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(request)).rejects.toThrow(
      "unknown status",
    );
  });

  test("does not silently ignore explicit overrides in the SDK fallback", async () => {
    const pi: CompatibleExtensionAPI = {
      getActiveTools: () => ["langgraph_orchestrate"],
    };
    const overridden: ExecutionRequest = {
      ...request,
      task: { ...request.task, model: "different-model" },
    };

    await expect(createTaskExecutor(pi, { cwd: "/tmp", model: undefined }).execute(overridden)).rejects.toThrow(
      "does not support per-task agent or model overrides",
    );
  });
});

test("worker prompt carries dependency outputs as structurally escaped data", () => {
  const prompt = buildTaskPrompt(request);
  const document = JSON.parse(prompt) as {
    protocol: string;
    objective: string;
    assignment: { id: string; instruction: string };
    dependencies: Array<{ id: string; status: string; output: string }>;
  };
  expect(document.protocol).toBe("pi-langgraph.task.v1");
  expect(document.objective).toBe("ship");
  expect(document.assignment).toEqual({ id: "review", instruction: "Review the implementation" });
  expect(document.dependencies).toEqual([{ id: "build", status: "completed", output: "built" }]);
});

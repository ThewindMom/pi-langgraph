import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import langGraphExtension from "../src/index.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { LangGraphExtensionAPI, RuntimeContext } from "../src/types.ts";

interface RegisteredTool {
  readonly name: string;
  readonly executionMode?: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: RuntimeContext,
  ): Promise<AgentToolResult<unknown>>;
}

test("registers a safe objective-first coding workflow contract", () => {
  let registered: RegisteredTool | undefined;
  const pi: LangGraphExtensionAPI = {
    registerTool(tool: unknown) {
      if (!isRegisteredTool(tool)) throw new Error("invalid registered tool");
      registered = tool;
    },
    getActiveTools: () => [],
  };

  langGraphExtension(pi);

  expect(registered?.name).toBe("langgraph_orchestrate");
  expect(registered?.executionMode).toBe("sequential");
});

test("executes the autonomous workflow through the registered Pi tool surface", async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), "pi-langgraph-agent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  let registered: RegisteredTool | undefined;
  const calls: string[] = [];
  const pi: LangGraphExtensionAPI = {
    registerTool(tool: unknown) {
      if (!isRegisteredTool(tool)) throw new Error("invalid registered tool");
      registered = tool;
    },
    getActiveTools: () => ["task", "langgraph_orchestrate"],
    async executeTool(_name: string, params: unknown) {
      if (!isRecord(params) || typeof params.name !== "string") throw new Error("invalid native task request");
      calls.push(params.name);
      const payload = outputFor(params.name);
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], details: { status: "completed" } };
    },
  };

  try {
    langGraphExtension(pi);
    if (registered === undefined) throw new Error("tool was not registered");
    const result = await registered.execute(
      "call-1",
      { objective: "Implement the settings API", threadId: "public-surface" },
      undefined,
      undefined,
      { cwd: agentRoot, model: undefined },
    );

    expect(calls).toEqual(["discover", "specialist_api", "implement", "verify", "synthesize"]);
    expect(isRecord(result.details) ? result.details.status : undefined).toBe("completed");
    expect(result.content[0]).toMatchObject({ type: "text" });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentRoot, { recursive: true, force: true });
  }
});

function outputFor(taskId: string): unknown {
  switch (taskId) {
    case "discover":
      return {
        workItems: [{ id: "api", title: "API", instruction: "Inspect the API" }],
        acceptanceCriteria: ["tests pass"],
      };
    case "specialist_api":
      return { summary: "located API", evidence: [], risks: [] };
    case "implement":
      return {
        summary: "implemented API",
        filesChanged: ["src/api.ts"],
        evidence: ["handler added"],
        unresolvedRisks: [],
      };
    case "verify":
      return { passed: true, summary: "passed", checks: [{ name: "tests", passed: true, evidence: "exit 0" }] };
    case "synthesize":
      return { summary: "Implemented and verified the settings API." };
    default:
      throw new Error(`unexpected task ${taskId}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRegisteredTool(value: unknown): value is RegisteredTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (value.executionMode === undefined || typeof value.executionMode === "string") &&
    typeof value.execute === "function"
  );
}

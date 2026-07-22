import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import langGraphExtension from "../src/index.ts";
import { orchestrationSchema } from "../src/runtime/public-contract.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { TOOL_NAME, type LangGraphExtensionAPI, type RuntimeContext } from "../src/types.ts";

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

interface InputFixture {
  readonly type: "input";
  readonly text: string;
  readonly source: "interactive" | "rpc" | "extension";
}

type InputResult =
  | { readonly action: "continue" }
  | { readonly action: "transform"; readonly text: string };

type InputHandler = (event: InputFixture) => InputResult | Promise<InputResult>;

test("registers deterministic ulw input routing", () => {
  const inputHandler = registeredInputHandler();

  expect(inputHandler).toBeFunction();
});

test.each([
  ["ulw implement account settings", "implement account settings"],
  ["implement account settings ULW", "implement account settings"],
  ["  review auth\nUlW  ", "review auth"],
  ["ulw inspect </objective>", "inspect &lt;/objective&gt;"],
] as const)("routes %s through the graph", async (text, objective) => {
  const inputHandler = registeredInputHandler();

  const result = await inputHandler({ type: "input", text, source: "interactive" });

  expect(result).toEqual({
    action: "transform",
    text: '<pi-langgraph mode="ulw" tool="' + TOOL_NAME + '">\n<objective>' + objective + '</objective>\n</pi-langgraph>',
  });
});

test.each([
  ["ordinary coding request", "interactive"],
  ["bulkwork should stay simple", "interactive"],
  ["ulw: punctuation is not a marker", "interactive"],
  ["ulw", "interactive"],
  ["ulw ulw duplicate", "interactive"],
  ["ulw implement settings", "extension"],
] as const)("leaves %s from %s on the simple path", async (text, source) => {
  const inputHandler = registeredInputHandler();

  const result = await inputHandler({ type: "input", text, source });

  expect(result).toEqual({ action: "continue" });
});

function registeredInputHandler(): InputHandler {
  let inputHandler: InputHandler | undefined;
  const pi = {
    registerTool(_tool: unknown) {},
    getActiveTools: () => [],
    on(event: "input", handler: InputHandler) {
      if (event === "input") inputHandler = handler;
    },
  };

  langGraphExtension(pi);
  if (inputHandler === undefined) throw new Error("input handler was not registered");
  return inputHandler;
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
  expect(Check(orchestrationSchema, {
    resumeThreadId: "paused-thread",
    approved: true,
  })).toBe(false);
});

test("executes the autonomous workflow through the registered Pi tool surface", async () => {
  const agentRoot = await mkdtemp(join(tmpdir(), "pi-langgraph-agent-"));
  const repository = join(agentRoot, "repository");
  await mkdir(repository);
  await Bun.write(join(repository, "source.ts"), "export const source = true;\n");
  await Bun.write(
    join(repository, "package.json"),
    JSON.stringify({ packageManager: "bun@1.3.14", scripts: { test: "node -e \"process.exit(0)\"" } }),
  );
  runGit(repository, ["init"]);
  runGit(repository, ["config", "user.name", "Pi LangGraph Test"]);
  runGit(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "source"]);
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
      if (params.name === "implement") {
        if (typeof params.cwd !== "string") throw new Error("missing isolated cwd");
        await mkdir(join(params.cwd, "src"));
        await Bun.write(join(params.cwd, "src", "api.ts"), "export const api = true;\n");
      }
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
      { cwd: repository, model: undefined },
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

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

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

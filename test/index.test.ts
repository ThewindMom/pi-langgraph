import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Check } from "typebox/value";
import { routeUlwInput } from "../src/activation.ts";
import { workflowFailureMessage } from "../src/extension-responses.ts";
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
  | { readonly action: "transform"; readonly text: string }
  | { readonly action: "handled" };

type InputHandler = (
  event: InputFixture,
  context: RuntimeContext & { readonly signal?: AbortSignal | undefined },
) => InputResult | Promise<InputResult>;

test("registers deterministic ulw input routing", () => {
  const inputHandler = registeredInputHandler();

  expect(inputHandler).toBeFunction();
});

test.each([
  [new DOMException("Aborted", "AbortError"), "cancelled"],
  [new Error("workflow failed"), "failed"],
] as const)("surfaces direct workflow terminal status %s", (error, status) => {
  expect(workflowFailureMessage(error).details).toEqual({
    status,
    error: error.message,
  });
});

test.each([
  ["ulw implement account settings", "interactive", "implement account settings"],
  ["implement account settings ULW", "rpc", "implement account settings"],
  ["  review auth\nUlW  ", "interactive", "review auth"],
  ["ulw inspect </objective>", "rpc", "inspect </objective>"],
] as const)("recognizes standalone ulw objective from %s", (text, source, objective) => {
  expect(routeUlwInput(text, source)).toEqual({ action: "dispatch", objective });
});

test.each([
  ["ordinary coding request", "interactive"],
  ["bulkwork should stay simple", "interactive"],
  ["ulw-ish should stay simple", "rpc"],
  ["ulw: punctuation is not a marker", "interactive"],
  ["ulw !!!", "rpc"],
  ["ulw", "interactive"],
  ["ulw ulw duplicate", "interactive"],
  ["ulw implement settings", "extension"],
] as const)("leaves ordinary Pi input untouched: %s from %s", async (text, source) => {
  const inputHandler = registeredInputHandler();

  const result = await inputHandler(
    { type: "input", text, source },
    { cwd: "/tmp", model: undefined },
  );

  expect(result).toEqual({ action: "continue" });
});

function registeredInputHandler(): InputHandler {
  let inputHandler: InputHandler | undefined;
  const pi = {
    registerTool(_tool: unknown) {},
    getActiveTools: () => [],
    sendMessage(_message: unknown) {},
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

test("does not expose the removed raw tasks DAG contract", async () => {
  // Given: the public tool schema and package entry point.
  const extension = await import("../src/index.ts");

  // When: a caller supplies the former raw-DAG payload.
  const acceptsRawTaskDag = Check(orchestrationSchema, {
    objective: "legacy compatibility request",
    tasks: [{ id: "worker", prompt: "do work" }],
    failurePolicy: "continue",
  });

  // Then: neither the payload nor its orchestration exports remain public.
  expect(acceptsRawTaskDag).toBe(false);
  expect("runOrchestration" in extension).toBe(false);
  expect("validatePlan" in extension).toBe(false);
  expect("InvalidPlanError" in extension).toBe(false);
});

test("dispatches standalone ulw directly", async () => {
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
  let inputHandler: InputHandler | undefined;
  const calls: string[] = [];
  const hostToolCalls: string[] = [];
  const messages: Array<Readonly<Record<string, unknown>>> = [];
  const pi: LangGraphExtensionAPI = {
    registerTool(tool: unknown) {
      if (!isRegisteredTool(tool)) throw new Error("invalid registered tool");
      registered = tool;
    },
    on(event: "input", handler: InputHandler) {
      if (event === "input") inputHandler = handler;
    },
    getActiveTools: () => ["task", "langgraph_orchestrate"],
    sendMessage(message: Readonly<Record<string, unknown>>, options?: Readonly<Record<string, unknown>>) {
      messages.push({ ...message, options });
    },
    async executeTool(name: string, params: unknown) {
      hostToolCalls.push(name);
      if (name === TOOL_NAME) throw new Error("direct input selected the orchestrator tool");
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
    if (inputHandler === undefined) throw new Error("input handler was not registered");

    const result = await inputHandler(
      { type: "input", text: "ulw Implement the settings API", source: "interactive" },
      { cwd: repository, model: undefined },
    );

    expect(result).toEqual({ action: "handled" });
    expect(hostToolCalls.filter((name) => name === TOOL_NAME)).toHaveLength(0);
    expect(hostToolCalls.filter((name) => name === "task")).toHaveLength(5);
    expect(calls).toEqual(["discover", "specialist_api", "implement", "verify", "synthesize"]);
    expect(messages.some((message) => message.customType === "pi-langgraph-progress")).toBe(true);
    expect(messages.every((message) => isRecord(message.options) && message.options.triggerTurn === false)).toBe(true);
    expect(messages.filter((message) => message.customType === "pi-langgraph-result")).toHaveLength(1);
    expect(messages).toContainEqual(expect.objectContaining({
      customType: "pi-langgraph-result",
      display: true,
      options: { triggerTurn: false },
      details: expect.objectContaining({ status: "completed" }),
    }));
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

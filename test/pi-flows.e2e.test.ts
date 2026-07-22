import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { createTaskExecutor } from "../src/executors.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { CompatibleExtensionAPI, ExecutionRequest, RuntimeContext, TaskExecutor } from "../src/types.ts";

const requests = [requestFor("child-alpha"), requestFor("child-beta")] as const;
const sdkManagers: object[] = [];
const sdkOptions: Array<Readonly<Record<string, unknown>>> = [];
const sdkSessions: FakeSession[] = [];
let blockNextSdkPrompt = false;
let emptyNextSdkOutput = false;
let resolveNextSdkSession: ((session: FakeSession) => void) | undefined;

type LeafEvent = {
  readonly taskId: string;
  readonly status: string;
};

const createExecutorWithEvents: (
  pi: CompatibleExtensionAPI,
  context: RuntimeContext,
  options: { readonly onEvent: (event: LeafEvent) => void },
) => TaskExecutor = createTaskExecutor;

beforeAll(() => {
  mock.module("@earendil-works/pi-coding-agent", () => ({
    SessionManager: {
      inMemory: () => {
        const manager = {};
        sdkManagers.push(manager);
        return manager;
      },
    },
    createAgentSession: async (options: Readonly<Record<string, unknown>>) => {
      sdkOptions.push(options);
      const session = new FakeSession();
      session.blockPrompt = blockNextSdkPrompt;
      session.emptyOutput = emptyNextSdkOutput;
      blockNextSdkPrompt = false;
      emptyNextSdkOutput = false;
      sdkSessions.push(session);
      resolveNextSdkSession?.(session);
      resolveNextSdkSession = undefined;
      return { session };
    },
  }));
});

afterAll(() => mock.restore());

test("native Pi tasks forward lifecycle updates with distinct child identities", async () => {
  // Given: a native task tool that emits a running update for every leaf.
  const calls: Array<{ readonly name: string; readonly options: unknown }> = [];
  const events: LeafEvent[] = [];
  const pi: CompatibleExtensionAPI = {
    getActiveTools: () => ["task", "langgraph_orchestrate"],
    async executeTool(name, params, options) {
      if (!isRecord(params) || typeof params.name !== "string") throw new Error("invalid native task params");
      calls.push({ name: params.name, options });
      options?.onUpdate?.(result("working", "running"));
      return result(`completed ${params.name}`, "completed");
    },
  };
  const executor = createExecutorWithEvents(pi, { cwd: "/tmp", model: undefined }, {
    onEvent: (event: LeafEvent) => events.push(event),
  });

  // When: two distinct semantic leaves execute through Pi's native task tree.
  await Promise.all(requests.map((request) => executor.execute(request)));

  // Then: Pi receives distinct child names and their bounded lifecycle reaches the caller.
  expect(calls.map((call) => call.name).sort()).toEqual(["child-alpha", "child-beta"]);
  expect(calls.every((call) => call.options !== undefined)).toBe(true);
  expect([...new Set(events.filter((event) => event.status === "running").map((event) => event.taskId))].sort()).toEqual([
    "child-alpha",
    "child-beta",
  ]);
  expect(events.filter((event) => event.status === "completed").map((event) => event.taskId).sort()).toEqual([
    "child-alpha",
    "child-beta",
  ]);
});

test("native Pi cancellation is forwarded and reported once", async () => {
  // Given: an in-flight native task whose host promise rejects when its signal aborts.
  const controller = new AbortController();
  const events: LeafEvent[] = [];
  let receivedSignal: AbortSignal | undefined;
  const pi: CompatibleExtensionAPI = {
    getActiveTools: () => ["task"],
    executeTool: async (_name, _params, options) => {
      receivedSignal = options?.signal;
      return new Promise<AgentToolResult<unknown>>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      });
    },
  };
  const executor = createExecutorWithEvents(pi, { cwd: "/tmp", model: undefined }, {
    onEvent: (event: LeafEvent) => events.push(event),
  });

  // When: the caller cancels the leaf.
  const pending = executor.execute(requests[0], controller.signal);
  controller.abort();

  // Then: the exact signal reaches Pi and one terminal cancellation event is emitted.
  await expect(pending).rejects.toThrow(/abort/i);
  expect(receivedSignal).toBe(controller.signal);
  expect(events.filter((event) => event.status === "cancelled")).toEqual([
    expect.objectContaining({ taskId: "child-alpha" }),
  ]);
});

test("native Pi completion update cannot hide a failed settled result", async () => {
  const events: LeafEvent[] = [];
  const pi: CompatibleExtensionAPI = {
    getActiveTools: () => ["task"],
    async executeTool(_name, _params, options) {
      options?.onUpdate?.(result("premature", "completed"));
      return result("settled failure", "failed");
    },
  };
  const executor = createExecutorWithEvents(pi, { cwd: "/tmp", model: undefined }, {
    onEvent: (event: LeafEvent) => events.push(event),
  });

  await expect(executor.execute(requests[0])).rejects.toThrow("settled failure");
  expect(events.filter((event) => event.status === "completed")).toEqual([]);
  expect(events.filter((event) => event.status === "failed")).toEqual([
    expect.objectContaining({ taskId: "child-alpha" }),
  ]);
});

test("SDK fallback creates isolated sessions, excludes recursive tools, and forwards lifecycle", async () => {
  // Given: Pi has no native task tool and the SDK boundary records each created session.
  const events: LeafEvent[] = [];
  const pi: CompatibleExtensionAPI = { getActiveTools: () => ["langgraph_orchestrate"] };
  const executor = createExecutorWithEvents(pi, { cwd: "/workspace", model: undefined }, {
    onEvent: (event: LeafEvent) => events.push(event),
  });

  // When: two leaves execute through the SDK fallback.
  const outputs = await Promise.all(requests.map((request) => executor.execute(request)));

  // Then: each leaf owns an in-memory session, both orchestrators are excluded, and lifecycle is distinct.
  expect(outputs).toEqual(["sdk completed", "sdk completed"]);
  expect(sdkManagers).toHaveLength(2);
  expect(sdkManagers[0]).not.toBe(sdkManagers[1]);
  expect(sdkOptions.map((options) => options.excludeTools)).toEqual([
    ["langgraph_orchestrate", "task"],
    ["langgraph_orchestrate", "task"],
  ]);
  expect(sdkSessions.every((session) => session.disposed)).toBe(true);
  expect([...new Set(events.filter((event) => event.status === "running").map((event) => event.taskId))].sort()).toEqual([
    "child-alpha",
    "child-beta",
  ]);
  expect(events.filter((event) => event.status === "completed").map((event) => event.taskId).sort()).toEqual([
    "child-alpha",
    "child-beta",
  ]);
});

test("SDK fallback awaits abort before disposing a cancelled session", async () => {
  // Given: an SDK leaf blocked in prompt until abort completes.
  const events: LeafEvent[] = [];
  const pi: CompatibleExtensionAPI = { getActiveTools: () => [] };
  const executor = createExecutorWithEvents(pi, { cwd: "/workspace", model: undefined }, {
    onEvent: (event: LeafEvent) => events.push(event),
  });
  const controller = new AbortController();
  blockNextSdkPrompt = true;
  const created = new Promise<FakeSession>((resolve) => {
    resolveNextSdkSession = resolve;
  });
  const pending = executor.execute(requestFor("cancelled-sdk-child"), controller.signal);
  const session = await created;
  await session.started;

  // When: cancellation reaches the active SDK leaf.
  controller.abort();
  await Promise.resolve();
  session.finishAbort?.();

  // Then: abort settles before disposal and cancellation is terminal exactly once.
  await expect(pending).rejects.toThrow(/abort/i);
  expect(session.lifecycle).toEqual(["abort:start", "abort:end", "dispose"]);
  expect(events.filter((event) => event.status === "cancelled")).toEqual([
    expect.objectContaining({ taskId: "cancelled-sdk-child" }),
  ]);
});

test("SDK agent end cannot hide an empty settled assistant result", async () => {
  const events: LeafEvent[] = [];
  emptyNextSdkOutput = true;
  const executor = createExecutorWithEvents(
    { getActiveTools: () => [] },
    { cwd: "/workspace", model: undefined },
    { onEvent: (event: LeafEvent) => events.push(event) },
  );

  await expect(executor.execute(requestFor("empty-sdk-child"))).rejects.toThrow("returned no text");
  expect(events.filter((event) => event.status === "completed")).toEqual([]);
  expect(events.filter((event) => event.status === "failed")).toEqual([
    expect.objectContaining({ taskId: "empty-sdk-child" }),
  ]);
});

class FakeSession {
  readonly messages: unknown[] = [];
  readonly lifecycle: string[] = [];
  readonly started: Promise<void>;
  disposed = false;
  blockPrompt = false;
  emptyOutput = false;
  private listener: ((event: Readonly<Record<string, unknown>>) => void) | undefined;
  private rejectPrompt: ((reason: unknown) => void) | undefined;
  private readonly resolveStarted: () => void;
  finishAbort: (() => void) | undefined;

  constructor() {
    let markStarted: () => void = () => {};
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.resolveStarted = markStarted;
  }

  subscribe(listener: (event: Readonly<Record<string, unknown>>) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  async prompt(): Promise<void> {
    this.resolveStarted();
    this.listener?.({ type: "agent_start" });
    if (this.blockPrompt) {
      await new Promise<void>((_resolve, reject) => {
        this.rejectPrompt = reject;
      });
      return;
    }
    if (!this.emptyOutput) {
      this.messages.push({ role: "assistant", content: [{ type: "text", text: "sdk completed" }] });
    }
    this.listener?.({ type: "agent_end", messages: [], willRetry: false });
  }

  async abort(): Promise<void> {
    this.lifecycle.push("abort:start");
    this.rejectPrompt?.(new DOMException("Aborted", "AbortError"));
    await new Promise<void>((resolve) => {
      this.finishAbort = resolve;
    });
    this.lifecycle.push("abort:end");
  }

  dispose(): void {
    this.lifecycle.push("dispose");
    this.disposed = true;
  }
}

function requestFor(taskId: string): ExecutionRequest {
  return {
    objective: "exercise Pi leaf execution",
    task: { id: taskId, prompt: `Run ${taskId}` },
    dependencyResults: [],
  };
}

function result(text: string, status: string): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details: { status } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

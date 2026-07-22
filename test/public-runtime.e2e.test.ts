import { expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import langGraphExtension from "../src/index.ts";
import type { LangGraphExtensionAPI, RuntimeContext } from "../src/types.ts";

type Update = (update: AgentToolResult<unknown>) => void;
interface RegisteredTool {
  execute(id: string, params: unknown, signal: AbortSignal | undefined, update: Update | undefined, context: RuntimeContext): Promise<AgentToolResult<unknown>>;
}

test("registered runtime owns repository services, evidence, cache, memory, and events", async () => {
  // Given: a real clean Git repository and a native Pi task adapter.
  const fixture = await fixtureFor("public-services");
  const calls: Array<{ readonly id: string; readonly cwd: string; readonly dependencies: readonly unknown[] }> = [];
  const updates: AgentToolResult<unknown>[] = [];
  const tool = registeredTool((params) => {
    const id = stringField(params, "name");
    const prompt = parseRecord(stringField(params, "prompt"));
    calls.push({ id, cwd: stringField(params, "cwd"), dependencies: arrayField(prompt, "dependencies") });
    return outputFor(id, "low");
  });

  try {
    // When: two identical delivery runs and a new exact-snapshot review use the public tool.
    const first = await tool.execute("one", { objective: "Implement public flow", threadId: "public-one" }, undefined, (update) => updates.push(update), fixture.context);
    await tool.execute("two", { objective: "Implement public flow", threadId: "public-two" }, undefined, undefined, fixture.context);
    await tool.execute("three", { objective: "Review public flow", workflow: "review", threadId: "public-three" }, undefined, undefined, fixture.context);

    // Then: host evidence is retained, only read-only leaves cache, memory is labelled untrusted, and graph events reach Pi.
    expect(recordField(first, "details").status).toBe("completed");
    expect(calls.filter((call) => call.id === "discover" && call.dependencies.length === 0)).toHaveLength(1);
    expect(calls.filter((call) => call.id.startsWith("implement"))).toHaveLength(2);
    expect(calls.findLast((call) => call.id === "discover")?.dependencies).toEqual([
      expect.objectContaining({ id: "repository_memory_exact_snapshot_untrusted", status: "completed" }),
    ]);
    expect(calls.every((call) => call.cwd !== fixture.repository && call.cwd.includes("pi-langgraph-worker-"))).toBe(true);
    expect(updates.some((update) => textOf(update).startsWith("workflow-event:"))).toBe(true);
    const files = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: fixture.agentRoot, onlyFiles: true }));
    expect(files.some((file) => file.endsWith("cache.json"))).toBe(true);
    expect(files.some((file) => file.endsWith("memory.json"))).toBe(true);
    expect(files.some((file) => file.endsWith("retention.json"))).toBe(true);
    expect(files.filter((file) => file.includes("/blobs/")).length).toBeGreaterThanOrEqual(2);
  } finally {
    await fixture.dispose();
  }
});

test("public cache misses when the effective Pi tool policy changes", async () => {
  // Given: two public runtimes sharing one clean repository and data root but exposing different active tools.
  const fixture = await fixtureFor("public-policy-cache");
  const calls: string[] = [];
  const first = registeredTool((params) => {
    const id = stringField(params, "name");
    calls.push(id);
    return outputFor(id, "low");
  });
  const second = registeredTool((params) => {
    const id = stringField(params, "name");
    calls.push(id);
    return outputFor(id, "low");
  }, ["task", "langgraph_orchestrate", "repository_search"]);

  try {
    // When: the identical read-only objective runs under each effective policy.
    await first.execute("policy-one", { objective: "Review cache policy", workflow: "review", threadId: "policy-one" }, undefined, undefined, fixture.context);
    await second.execute("policy-two", { objective: "Review cache policy", workflow: "review", threadId: "policy-two" }, undefined, undefined, fixture.context);

    // Then: discovery executes once per policy instead of reusing stale output.
    expect(calls.filter((id) => id === "discover")).toHaveLength(2);
  } finally {
    await fixture.dispose();
  }
});

test("public fork clones an exact LangGraph checkpoint into an isolated Git worktree", async () => {
  // Given: a public workflow paused at a high-risk checkpoint.
  const fixture = await fixtureFor("public-fork");
  const calls: Array<{ readonly id: string; readonly cwd: string }> = [];
  const tool = registeredTool((params) => {
    const id = stringField(params, "name");
    calls.push({ id, cwd: stringField(params, "cwd") });
    return outputFor(id, "high");
  });

  try {
    await tool.execute("pause", { objective: "Implement risky flow", threadId: "source-thread" }, undefined, undefined, fixture.context);
    const historyResult = await tool.execute("history", { action: "history", threadId: "source-thread" }, undefined, undefined, fixture.context);
    const history = arrayField(recordField(historyResult, "details"), "history");
    const checkpointId = stringField(recordValue(history.at(0)), "checkpointId");
    const gitCommit = git(fixture.repository, ["rev-parse", "HEAD"]);
    await writeFile(join(fixture.repository, "later.ts"), "export const later = true;\n");
    git(fixture.repository, ["add", "later.ts"]);
    git(fixture.repository, ["commit", "-m", "later repository state"]);
    const laterCommit = git(fixture.repository, ["rev-parse", "HEAD"]);

    await expect(tool.execute("mismatched-fork", {
      action: "fork", sourceThreadId: "source-thread", checkpointId, gitCommit: laterCommit, forkThreadId: "mismatch-thread",
    }, undefined, undefined, fixture.context)).rejects.toThrow(/checkpoint.*repository|repository.*checkpoint/i);

    // When: the exact checkpoint is forked and resumed with a structured decision.
    const forked = await tool.execute("fork", {
      action: "fork", sourceThreadId: "source-thread", checkpointId, gitCommit, forkThreadId: "fork-thread",
    }, undefined, undefined, fixture.context);
    const manifest = recordField(recordField(forked, "details"), "manifest");
    const workspacePath = stringField(manifest, "workspacePath");
    const listed = await tool.execute("list", { action: "list" }, undefined, undefined, fixture.context);
    const forkApproval = await tool.execute("fork-approval", {
      resumeThreadId: "fork-thread",
    }, undefined, undefined, fixture.context);
    const forkInterrupt = recordField(recordField(forkApproval, "details"), "interrupt");
    const resumed = await tool.execute("resume", {
      resumeThreadId: "fork-thread",
      decision: decisionFromInterrupt(forkInterrupt),
    }, undefined, undefined, fixture.context);

    // Then: child execution is cwd-bound while source bytes and history remain unchanged.
    expect(recordField(resumed, "details").status).toBe("completed");
    expect(recordField(forkApproval, "details").status).toBe("awaiting_approval");
    expect(stringField(forkInterrupt, "threadId")).toBe("fork-thread");
    expect(arrayField(recordField(listed, "details"), "threadIds")).toEqual(["fork-thread", "source-thread"]);
    expect(calls.filter((call) => call.id.startsWith("implement")).at(-1)?.cwd).not.toBe(workspacePath);
    expect(calls.filter((call) => call.id.startsWith("implement")).at(-1)?.cwd).toContain("pi-langgraph-worker-");
    expect(git(workspacePath, ["rev-parse", "HEAD"])).toBe(gitCommit);
    expect(git(fixture.repository, ["status", "--porcelain=v1"])).toBe("");
    expect(await readFile(join(fixture.repository, "feature.ts"), "utf8")).toBe("export const source = true;\n");
  } finally {
    await fixture.dispose();
  }
});

async function fixtureFor(name: string): Promise<{ readonly agentRoot: string; readonly repository: string; readonly context: RuntimeContext; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), `pi-langgraph-${name}-`));
  const agentRoot = join(root, "agent");
  const repository = join(root, "repository");
  await mkdir(agentRoot);
  await mkdir(repository);
  await writeFile(join(repository, "feature.ts"), "export const source = true;\n");
  await writeFile(join(repository, "package.json"), JSON.stringify({ scripts: { "check:public": "printf public-evidence" }, packageManager: "bun@1.3.14" }));
  git(repository, ["init"]); git(repository, ["config", "user.name", "Pi Test"]); git(repository, ["config", "user.email", "pi@example.invalid"]);
  git(repository, ["add", "."]); git(repository, ["commit", "-m", "source"]);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentRoot;
  return {
    agentRoot, repository, context: { cwd: repository, model: undefined },
    async dispose() { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(root, { recursive: true, force: true }); },
  };
}

function registeredTool(
  output: (params: Readonly<Record<string, unknown>>) => unknown,
  activeTools: readonly string[] = ["task", "langgraph_orchestrate"],
): RegisteredTool {
  let tool: RegisteredTool | undefined;
  const pi: LangGraphExtensionAPI = {
    getActiveTools: () => [...activeTools],
    registerTool(value: unknown) { if (!isRegisteredTool(value)) throw new Error("invalid tool"); tool = value; },
    async executeTool(_name, params) { const record = recordValue(params); return { content: [{ type: "text", text: JSON.stringify(output(record)) }], details: { status: "completed" } }; },
  };
  langGraphExtension(pi);
  if (tool === undefined) throw new Error("tool not registered");
  return tool;
}

function outputFor(id: string, risk: "low" | "high"): unknown {
  if (id === "discover") return { workItems: [{ id: "core", title: "Core", instruction: "Inspect" }], acceptanceCriteria: ["check"], executionPlan: { version: 1, planId: "public-plan", revision: 1, changes: [{ changeId: "core", title: "Core", instruction: "Implement", dependsOn: [], scope: { files: ["feature.ts"] }, risk: { level: risk, reasons: risk === "high" ? ["risky"] : [] }, acceptanceChecks: [{ kind: "package_script", script: "check:public" }], status: "pending" }] } };
  if (id === "specialist_core") return { summary: "found", evidence: [], risks: [], discoveredWorkItems: [] };
  if (id.startsWith("implement")) return { summary: "implemented", filesChanged: [], evidence: [], unresolvedRisks: [] };
  if (id === "verify") return { passed: true, summary: "passed", checks: [{ name: "integration", passed: true, evidence: "exit 0" }] };
  if (id === "synthesize") return { summary: "complete" };
  throw new Error(`unexpected task ${id}`);
}

function git(cwd: string, args: readonly string[]): string { const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr)); return new TextDecoder().decode(result.stdout).trim(); }
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function recordValue(value: unknown): Readonly<Record<string, unknown>> { if (!isRecord(value)) throw new Error("expected record"); return value; }
function recordField(value: unknown, field: string): Readonly<Record<string, unknown>> { return recordValue(recordValue(value)[field]); }
function stringField(value: Readonly<Record<string, unknown>>, field: string): string { const item = value[field]; if (typeof item !== "string") throw new Error(`expected ${field}`); return item; }
function arrayField(value: Readonly<Record<string, unknown>>, field: string): readonly unknown[] { const item = value[field]; if (!Array.isArray(item)) throw new Error(`expected ${field}`); return item; }
function numberField(value: Readonly<Record<string, unknown>>, field: string): number { const item = value[field]; if (typeof item !== "number") throw new Error(`expected ${field}`); return item; }
function decisionFromInterrupt(interrupt: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const threadId = interrupt.threadId;
  const checkpointId = interrupt.checkpointId;
  return {
    interruptId: stringField(interrupt, "interruptId"),
    changeId: stringField(interrupt, "changeId"),
    planId: stringField(interrupt, "planId"),
    revision: numberField(interrupt, "revision"),
    attempt: numberField(interrupt, "attempt"),
    scope: recordField(interrupt, "scope"),
    allowedScripts: arrayField(interrupt, "allowedScripts"),
    ...(typeof threadId === "string" ? { threadId } : {}),
    ...(typeof checkpointId === "string" ? { checkpointId } : {}),
    action: "approve",
  };
}
function parseRecord(value: string): Readonly<Record<string, unknown>> { return recordValue(JSON.parse(value)); }
function textOf(result: AgentToolResult<unknown>): string { const item = result.content[0]; return item?.type === "text" ? item.text : ""; }
function isRegisteredTool(value: unknown): value is RegisteredTool { return isRecord(value) && typeof value.execute === "function"; }

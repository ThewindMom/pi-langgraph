import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { createOrchestrationDispatcher } from "../src/runtime/orchestration-dispatcher.ts";
import type { TaskEffectAttestingExtensionAPI } from "../src/runtime/task-execution-effects.ts";
import type { LangGraphExtensionAPI, RuntimeContext } from "../src/types.ts";

test("opaque task execution blocks automatic backtracking before candidate workers start", async () => {
  // Given: an opaque native Pi worker whose first delivery attempt exhausts verification.
  const fixture = await runtimeFixture("opaque");
  const candidateStarts: string[] = [];
  const dispatcher = createOrchestrationDispatcher(
    piWorker(false, candidateStarts),
    fixture.dataRoot,
  );

  try {
    // When: production dispatch reaches automatic recovery.
    const result = await dispatcher({
      input: {
        objective: "Repair the repository safely",
        threadId: "opaque-effects",
        maxIterations: 1,
      },
      context: fixture.context,
    });

    // Then: effect uncertainty is visible and no candidate worker was invoked.
    expect(automaticBacktrack(result)).toEqual({
      kind: "needs_attention",
      reason: "unsafe-effects",
    });
    expect(candidateStarts).toEqual([]);
  } finally {
    await fixture.dispose();
  }
});

test("repository-only reversible task execution may run automatic candidates", async () => {
  // Given: the same failed delivery under a host-enforced repository-only capability contract.
  const fixture = await runtimeFixture("repository-only");
  const candidateStarts: string[] = [];
  const dispatcher = createOrchestrationDispatcher(
    piWorker(true, candidateStarts),
    fixture.dataRoot,
  );

  try {
    // When: production dispatch reaches automatic recovery.
    const result = await dispatcher({
      input: {
        objective: "Repair the repository safely",
        threadId: "repository-only-effects",
        maxIterations: 1,
      },
      context: fixture.context,
    });

    // Then: exactly two attested candidates execute and recovery is not effect-blocked.
    expect(new Set(candidateStarts).size).toBe(2);
    expect(candidateStarts).toHaveLength(2);
    expect(automaticBacktrack(result)).not.toEqual({
      kind: "needs_attention",
      reason: "unsafe-effects",
    });
  } finally {
    await fixture.dispose();
  }
}, 15_000);

function piWorker(
  repositoryOnly: boolean,
  candidateStarts: string[],
): LangGraphExtensionAPI & TaskEffectAttestingExtensionAPI {
  const api: LangGraphExtensionAPI = {
    registerTool() {},
    getActiveTools: () => ["task"],
    async executeTool(_toolName: string, params: unknown): Promise<AgentToolResult<unknown>> {
      const input = record(params);
      const id = stringField(input, "name");
      const prompt = record(JSON.parse(stringField(input, "prompt")));
      const variant = candidateVariant(prompt);
      if (variant !== undefined && isMutationWorker(id)) {
        candidateStarts.push(variant);
      }
      return workerResult(id, variant);
    },
  };
  return repositoryOnly
    ? {
        ...api,
        attestTaskExecutionEffects: () => ({
          protocolVersion: 1,
          scope: "repository-only",
          reversible: true,
        }),
      }
    : api;
}

function workerResult(
  id: string,
  variant: string | undefined,
): AgentToolResult<unknown> {
  let output: unknown;
  if (id === "discover") {
    output = {
      workItems: [{ id: "core", title: "Core", instruction: "Repair feature.ts" }],
      acceptanceCriteria: ["verification passes"],
    };
  } else if (id === "specialist_core") {
    output = { summary: "found", evidence: [], risks: [], discoveredWorkItems: [] };
  } else if (isMutationWorker(id)) {
    output = {
      summary: "implemented",
      filesChanged: [],
      evidence: [],
      unresolvedRisks: [],
    };
  } else if (id === "verify") {
    const passed = variant !== undefined;
    output = {
      passed,
      summary: passed ? "passed" : "failed",
      checks: [{
        name: "package:test",
        passed,
        evidence: passed ? "exit 0" : "exit 1",
      }],
    };
  } else if (id === "diagnose") {
    output = {
      summary: "repair remains local",
      rootCauses: ["feature.ts is still incorrect"],
      repairInstructions: ["repair feature.ts"],
    };
  } else if (id === "synthesize") {
    output = { summary: "complete" };
  } else {
    throw new RuntimeEffectSafetyTestError(`unexpected worker ${id}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    details: { status: "completed" },
  };
}

function isMutationWorker(id: string): boolean {
  return id.startsWith("implement") || id.startsWith("repair");
}

function candidateVariant(prompt: Readonly<Record<string, unknown>>): string | undefined {
  const dependencies = prompt.dependencies;
  if (!Array.isArray(dependencies)) return undefined;
  for (const dependency of dependencies) {
    if (!isRecord(dependency) || dependency.id !== "automatic_backtrack_variant") continue;
    if (typeof dependency.output !== "string") return undefined;
    const marker = record(JSON.parse(dependency.output));
    return typeof marker.variant === "string" ? marker.variant : undefined;
  }
  return undefined;
}

function automaticBacktrack(
  result: AgentToolResult<unknown>,
): Readonly<Record<string, unknown>> {
  const details = record(result.details);
  if (!isRecord(details.automaticBacktrack)) {
    throw new RuntimeEffectSafetyTestError(
      `expected automatic backtrack in ${JSON.stringify(details)}`,
    );
  }
  return details.automaticBacktrack;
}

async function runtimeFixture(name: string): Promise<{
  readonly dataRoot: string;
  readonly context: RuntimeContext;
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pi-effect-safety-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "feature.ts"), "export const baseline = true;\n");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({
      scripts: { "check:test": "exit 1" },
      packageManager: "bun@1.3.14",
    }),
  );
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi Effect Safety Test"]);
  git(repository, ["config", "user.email", "pi-effect-safety@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  return {
    dataRoot: join(root, "data"),
    context: { cwd: repository, model: undefined },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new RuntimeEffectSafetyTestError(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string {
  const item = value[field];
  if (typeof item !== "string") {
    throw new RuntimeEffectSafetyTestError(`expected ${field}`);
  }
  return item;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new RuntimeEffectSafetyTestError("expected record");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class RuntimeEffectSafetyTestError extends Error {
  readonly name = "RuntimeEffectSafetyTestError";
}

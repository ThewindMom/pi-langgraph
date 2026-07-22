import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostEvidenceRunner } from "../src/evidence/runner.ts";
import type { ArtifactRef } from "../src/evidence/types.ts";
import type { TaskExecutor } from "../src/types.ts";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";

test("host integration failure overrides a worker claimed pass", async () => {
  // Given: an aggregate delivery whose real package test exits nonzero.
  const cwd = await mkdtemp(join(tmpdir(), "pi-langgraph-trusted-final-"));
  const calls: string[] = [];
  const artifacts: string[] = [];
  const artifactStore = {
    async put(content: string | Uint8Array): Promise<ArtifactRef> {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      artifacts.push(new TextDecoder().decode(bytes));
      return { digest: `${artifacts.length}`.padStart(64, "0"), byteCount: bytes.byteLength, truncated: false };
    },
  };
  const executor: TaskExecutor = {
    async execute({ task }) {
      calls.push(task.id);
      if (task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
          acceptanceCriteria: ["host tests pass"],
        });
      }
      if (task.id === "specialist_core") {
        return JSON.stringify({ summary: "found", evidence: [], risks: [], discoveredWorkItems: [] });
      }
      if (task.id === "implement") {
        return JSON.stringify({ summary: "changed", filesChanged: [], evidence: [], unresolvedRisks: [] });
      }
      if (task.id === "verify") {
        return JSON.stringify({
          passed: true,
          summary: "worker claimed pass",
          checks: [{ name: "test", passed: true, evidence: "claimed exit 0" }],
        });
      }
      if (task.id === "synthesize") return JSON.stringify({ summary: "must not complete" });
      throw new Error(`unexpected task ${task.id}`);
    },
  };

  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      packageManager: "bun@1.3.14",
      scripts: { test: "node -e 'process.exit(9)'" },
    }));
    const runner = new HostEvidenceRunner({ cwd, artifactStore });

    // When: final integration verification runs after the worker claim.
    const result = await runCodingWorkflow(
      { objective: "Implement trusted verification", maxIterations: 0 },
      executor,
      { evidenceRunner: runner, threadId: "trusted-final", retainCheckpoint: true },
    );

    // Then: the host exit status prevents completion and is retained as evidence.
    expect(result.status).toBe("needs_attention");
    if (result.status === "awaiting_approval") throw new Error("workflow unexpectedly paused");
    expect(result.verification?.passed).toBe(false);
    expect(result.verification?.checks).toContainEqual(expect.objectContaining({ name: "package:test", passed: false }));
    expect(calls).toContain("verify");
    expect(calls).not.toContain("synthesize");
    expect(result.evidenceRefs.length).toBeGreaterThanOrEqual(2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default integration checks are selected from prioritized existing scripts", async () => {
  // Given: prioritized and unrelated package scripts.
  const cwd = await mkdtemp(join(tmpdir(), "pi-langgraph-default-checks-"));
  const artifactStore = { async put(): Promise<ArtifactRef> {
    return { digest: "0".repeat(64), byteCount: 0, truncated: false };
  } };
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({
      scripts: { deploy: "false", build: "true", "check:types": "true", lint: "true", test: "true" },
    }));
    const runner = new HostEvidenceRunner({ cwd, artifactStore });

    // When: the host selects its integration scripts.
    const scripts = await runner.defaultIntegrationScripts();

    // Then: only existing verification families are returned in host priority order.
    expect(scripts).toEqual(["test", "check:types", "lint", "build"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delivery cannot complete when no trusted evidence runner is available", async () => {
  const calls: string[] = [];
  const result = await runCodingWorkflow(
    { objective: "Implement without an evidence runner", maxIterations: 0 },
    claimingExecutor(calls),
    { threadId: "missing-evidence-runner", retainCheckpoint: true },
  );

  expect(result.status).toBe("needs_attention");
  if (result.status === "awaiting_approval") throw new Error("workflow unexpectedly paused");
  expect(result.verification?.passed).toBe(false);
  expect(result.verification?.checks).toContainEqual(expect.objectContaining({
    name: "host-integration",
    passed: false,
  }));
  expect(calls).not.toContain("synthesize");
});

test("delivery cannot complete when the host selects zero executable checks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-langgraph-no-host-checks-"));
  const calls: string[] = [];
  const artifactStore = { async put(): Promise<ArtifactRef> {
    return { digest: "0".repeat(64), byteCount: 0, truncated: false };
  } };
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
    const result = await runCodingWorkflow(
      { objective: "Implement without configured checks", maxIterations: 0 },
      claimingExecutor(calls),
      {
        threadId: "zero-host-checks",
        retainCheckpoint: true,
        evidenceRunner: new HostEvidenceRunner({ cwd, artifactStore }),
      },
    );

    expect(result.status).toBe("needs_attention");
    if (result.status === "awaiting_approval") throw new Error("workflow unexpectedly paused");
    expect(result.verification?.checks).toEqual([{
      name: "host-integration",
      passed: false,
      evidence: "no executable host integration scripts configured",
    }]);
    expect(result.evidenceRefs).toEqual([]);
    expect(calls).not.toContain("synthesize");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

function claimingExecutor(calls: string[]): TaskExecutor {
  return {
    async execute({ task }) {
      calls.push(task.id);
      if (task.id === "discover") return JSON.stringify({
        workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
        acceptanceCriteria: ["trusted checks pass"],
      });
      if (task.id === "specialist_core") {
        return JSON.stringify({ summary: "found", evidence: [], risks: [], discoveredWorkItems: [] });
      }
      if (task.id === "implement") {
        return JSON.stringify({ summary: "changed", filesChanged: [], evidence: [], unresolvedRisks: [] });
      }
      if (task.id === "verify") return JSON.stringify({
        passed: true,
        summary: "worker claimed pass",
        checks: [{ name: "worker", passed: true, evidence: "claim" }],
      });
      if (task.id === "synthesize") return JSON.stringify({ summary: "must not complete" });
      throw new Error(`unexpected task ${task.id}`);
    },
  };
}

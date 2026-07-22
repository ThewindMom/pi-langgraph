import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { fileNameForThread } from "../src/persistence/file-checkpoint-format.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";
import { conditionalEvidenceRunner } from "./helpers/evidence.ts";

test("does not invoke implementation twice after its mutation succeeds but its result is lost", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-implement-fence-"));
  let implementationCalls = 0;
  let observableMutations = 0;
  const evidenceRunner = conditionalEvidenceRunner(() => observableMutations === 1);
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover":
          return discoveryOutput();
        case "specialist_core":
          return findingOutput();
        case "implement":
          implementationCalls += 1;
          observableMutations += 1;
          if (implementationCalls === 1) throw new Error("crash after implementation mutation");
          return changeOutput("implemented core");
        case "verify":
          return verificationOutput(observableMutations === 1);
        case "diagnose":
          return diagnosticOutput();
        case "repair":
          return changeOutput("repaired core");
        case "synthesize":
          return JSON.stringify({ summary: "implementation reconciled and verified" });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  try {
    const directory = join(root, "checkpoints");
    const saver = await FileCheckpointSaver.open(directory);
    await expect(
      runCodingWorkflow(
        { objective: "Implement core", maxIterations: 1 },
        executor,
        { checkpointer: saver, threadId: "implement-fence", retainCheckpoint: true, evidenceRunner },
      ),
    ).rejects.toThrow("crash after implementation mutation");

    const reopened = await FileCheckpointSaver.open(directory);
    const result = await resumeCodingWorkflow("implement-fence", executor, {
      checkpointer: reopened,
      retainCheckpoint: true,
      evidenceRunner,
    });

    expect(result.status).toBe("completed");
    expect(observableMutations).toBe(1);
    expect(implementationCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not invoke the same repair twice after an indeterminate repair result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-repair-fence-"));
  let verificationCalls = 0;
  let repairCalls = 0;
  let observableRepairs = 0;
  const evidenceRunner = conditionalEvidenceRunner(() => verificationCalls > 1 && observableRepairs === 1);
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover":
          return discoveryOutput();
        case "specialist_core":
          return findingOutput();
        case "implement":
          return changeOutput("implemented core");
        case "verify":
          verificationCalls += 1;
          return verificationOutput(verificationCalls > 1 && observableRepairs === 1);
        case "diagnose":
          return diagnosticOutput();
        case "repair":
          repairCalls += 1;
          observableRepairs += 1;
          if (repairCalls === 1) throw new Error("crash after repair mutation");
          return changeOutput("repaired core");
        case "synthesize":
          return JSON.stringify({ summary: "repair reconciled and verified" });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  try {
    const directory = join(root, "checkpoints");
    const saver = await FileCheckpointSaver.open(directory);
    await expect(
      runCodingWorkflow(
        { objective: "Repair core", maxIterations: 2 },
        executor,
        { checkpointer: saver, threadId: "repair-fence", retainCheckpoint: true, evidenceRunner },
      ),
    ).rejects.toThrow("crash after repair mutation");

    const reopened = await FileCheckpointSaver.open(directory);
    const result = await resumeCodingWorkflow("repair-fence", executor, {
      checkpointer: reopened,
      retainCheckpoint: true,
      evidenceRunner,
    });

    expect(result.status).toBe("completed");
    expect(observableRepairs).toBe(1);
    expect(repairCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists completed and indeterminate mutation claims across saver instances", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-mutation-journal-"));
  try {
    const saver = await FileCheckpointSaver.open(root);
    const completed = { kind: "implement" as const, iteration: 0 };
    const indeterminate = { kind: "repair" as const, iteration: 1 };
    expect(await saver.claimMutation("completed-claim", completed)).toEqual({ status: "execute" });
    await saver.completeMutation("completed-claim", completed, "observed output");
    expect(await saver.claimMutation("indeterminate-claim", indeterminate)).toEqual({ status: "execute" });

    const reopened = await FileCheckpointSaver.open(root);
    expect(await reopened.claimMutation("completed-claim", completed)).toEqual({
      status: "replay",
      output: "observed output",
    });
    expect(await reopened.claimMutation("indeterminate-claim", indeterminate)).toEqual({
      status: "indeterminate",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies the workspace when a completed mutation returns an invalid report", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-invalid-mutation-report-"));
  let implementationCalls = 0;
  let verificationCalls = 0;
  const evidenceRunner = conditionalEvidenceRunner(() => implementationCalls === 1);
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover":
          return discoveryOutput();
        case "specialist_core":
          return findingOutput();
        case "implement":
          implementationCalls += 1;
          return "mutation completed but report was truncated";
        case "verify":
          verificationCalls += 1;
          return verificationOutput(implementationCalls === 1);
        case "synthesize":
          return JSON.stringify({ summary: "workspace reconciled and verified" });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  try {
    const saver = await FileCheckpointSaver.open(root);
    const result = await runCodingWorkflow(
      { objective: "Implement core", maxIterations: 1 },
      executor,
      { checkpointer: saver, threadId: "invalid-mutation-report", retainCheckpoint: true, evidenceRunner },
    );
    expect(result.status).toBe("completed");
    expect(implementationCalls).toBe(1);
    expect(verificationCalls).toBe(1);
    expect(result.verification?.passed).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates an ambiguous version-one implementation as indeterminate instead of replaying it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-v1-mutation-"));
  let implementationCalls = 0;
  const evidenceRunner = conditionalEvidenceRunner(() => implementationCalls === 1);
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover": return discoveryOutput();
        case "specialist_core": return findingOutput();
        case "implement":
          implementationCalls += 1;
          if (implementationCalls === 1) throw new Error("legacy crash after mutation");
          return changeOutput("duplicate implementation");
        case "verify": return verificationOutput(implementationCalls === 1);
        case "synthesize": return JSON.stringify({ summary: "legacy mutation reconciled" });
        default: throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  try {
    const directory = join(root, "checkpoints");
    const saver = await FileCheckpointSaver.open(directory);
    await expect(runCodingWorkflow(
      { objective: "Implement legacy core", maxIterations: 1 },
      executor,
      { checkpointer: saver, threadId: "legacy-mutation", retainCheckpoint: true, evidenceRunner },
    )).rejects.toThrow("legacy crash after mutation");

    const path = join(directory, fileNameForThread("legacy-mutation"));
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("checkpoint fixture is invalid");
    const { mutations: _mutations, ...withoutMutations } = parsed;
    const legacy = { ...withoutMutations, version: 1 };
    await writeFile(path, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

    const reopened = await FileCheckpointSaver.open(directory);
    const result = await resumeCodingWorkflow("legacy-mutation", executor, {
      checkpointer: reopened,
      retainCheckpoint: true,
      evidenceRunner,
    });
    expect(result.status).toBe("completed");
    expect(implementationCalls).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function discoveryOutput(): string {
  return JSON.stringify({
    workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
    acceptanceCriteria: ["tests pass"],
  });
}

function findingOutput(): string {
  return JSON.stringify({ summary: "found core", evidence: [], risks: [], discoveredWorkItems: [] });
}

function changeOutput(summary: string): string {
  return JSON.stringify({ summary, filesChanged: ["src/core.ts"], evidence: [summary], unresolvedRisks: [] });
}

function verificationOutput(passed: boolean): string {
  return JSON.stringify({
    passed,
    summary: passed ? "tests pass" : "tests fail",
    checks: [{ name: "tests", passed, evidence: passed ? "exit 0" : "exit 1" }],
  });
}

function diagnosticOutput(): string {
  return JSON.stringify({
    summary: "mutation outcome requires reconciliation",
    rootCauses: ["mutation result was not durable"],
    repairInstructions: ["repair only the remaining failed behavior"],
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";

test("quarantines incomplete workflow channels and contradictory completed verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-semantic-checkpoint-"));
  const directory = join(root, "checkpoints");
  const missingObjectiveThread = "missing-objective-state";
  const contradictoryThread = "contradictory-verification";

  try {
    const saver = await FileCheckpointSaver.open(directory);
    const missingObjective = validWorkflowState();
    delete missingObjective.objective;
    await saver.put(
      { configurable: { thread_id: missingObjectiveThread } },
      checkpoint("checkpoint-missing-objective", missingObjective),
      { source: "input", step: -1, parents: {} },
      {},
    );
    const contradictory = validWorkflowState();
    contradictory.pattern = "delivery";
    contradictory.phase = "synthesized";
    contradictory.status = "completed";
    contradictory.changes = [
      {
        kind: "implementation",
        summary: "implemented",
        filesChanged: ["src/core.ts"],
        evidence: ["changed"],
        unresolvedRisks: [],
      },
    ];
    contradictory.verification = {
      passed: true,
      summary: "contradictory",
      checks: [{ name: "tests", passed: false, evidence: "exit 1" }],
    };
    contradictory.summary = "incorrect completion";
    await saver.put(
      { configurable: { thread_id: contradictoryThread } },
      checkpoint("checkpoint-contradictory", contradictory),
      { source: "input", step: -1, parents: {} },
      {},
    );

    const reopened = await FileCheckpointSaver.open(directory);
    await expect(reopened.getTuple({ configurable: { thread_id: missingObjectiveThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    await expect(reopened.getTuple({ configurable: { thread_id: contradictoryThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantines phase-incomplete workflow state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-phase-incomplete-"));
  const directory = join(root, "checkpoints");
  const discoveredThread = "empty-discovery-state";
  const diagnosedThread = "empty-diagnostic-state";
  const diagnosedAtBoundThread = "diagnosed-at-repair-bound";

  try {
    const saver = await FileCheckpointSaver.open(directory);
    const discovered = validWorkflowState();
    discovered.phase = "discovered";
    await saver.put(
      { configurable: { thread_id: discoveredThread } },
      checkpoint("checkpoint-empty-discovery", discovered),
      { source: "input", step: -1, parents: {} },
      {},
    );

    const diagnosedAtBound = validWorkflowState();
    diagnosedAtBound.pattern = "delivery";
    diagnosedAtBound.maxIterations = 1;
    diagnosedAtBound.iteration = 1;
    diagnosedAtBound.phase = "diagnosed";
    diagnosedAtBound.workItems = [{ id: "core", title: "Core", instruction: "Implement core behavior" }];
    diagnosedAtBound.acceptanceCriteria = ["tests pass"];
    diagnosedAtBound.changes = [
      { kind: "implementation", summary: "implemented", filesChanged: ["src/core.ts"], evidence: ["changed"], unresolvedRisks: [] },
      { kind: "repair", summary: "repaired", filesChanged: ["src/core.ts"], evidence: ["changed"], unresolvedRisks: [] },
    ];
    diagnosedAtBound.verification = {
      passed: false,
      summary: "failed",
      checks: [{ name: "tests", passed: false, evidence: "exit 1" }],
    };
    diagnosedAtBound.diagnostic = {
      summary: "diagnosed",
      rootCauses: ["remaining failure"],
      repairInstructions: ["repair again"],
    };
    await saver.put(
      { configurable: { thread_id: diagnosedAtBoundThread } },
      checkpoint("checkpoint-diagnosed-at-bound", diagnosedAtBound),
      { source: "input", step: -1, parents: {} },
      {},
    );

    const diagnosed = validWorkflowState();
    diagnosed.pattern = "delivery";
    diagnosed.maxIterations = 1;
    diagnosed.phase = "diagnosed";
    diagnosed.workItems = [{ id: "core", title: "Core", instruction: "Implement core behavior" }];
    diagnosed.acceptanceCriteria = ["tests pass"];
    diagnosed.changes = [
      {
        kind: "implementation",
        summary: "implemented",
        filesChanged: ["src/core.ts"],
        evidence: ["changed"],
        unresolvedRisks: [],
      },
    ];
    diagnosed.verification = {
      passed: false,
      summary: "failed",
      checks: [{ name: "tests", passed: false, evidence: "exit 1" }],
    };
    diagnosed.diagnostic = {
      summary: "diagnosed",
      rootCauses: [],
      repairInstructions: [],
    };
    await saver.put(
      { configurable: { thread_id: diagnosedThread } },
      checkpoint("checkpoint-empty-diagnostic", diagnosed),
      { source: "input", step: -1, parents: {} },
      {},
    );

    const reopened = await FileCheckpointSaver.open(directory);
    await expect(reopened.getTuple({ configurable: { thread_id: discoveredThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    await expect(reopened.getTuple({ configurable: { thread_id: diagnosedThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    await expect(reopened.getTuple({ configurable: { thread_id: diagnosedAtBoundThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("quarantines invalid pending workflow writes without disabling a healthy thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-pending-write-validation-"));
  const directory = join(root, "checkpoints");
  const invalidThread = "invalid-pending-writes";
  const healthyThread = "healthy-pending-write-neighbor";

  try {
    const saver = await FileCheckpointSaver.open(directory);
    const invalidConfig = await saver.put(
      { configurable: { thread_id: invalidThread } },
      checkpoint("checkpoint-invalid-pending", validWorkflowState()),
      { source: "input", step: -1, parents: {} },
      {},
    );
    await saver.putWrites(
      invalidConfig,
      [
        ["phase", "discovered"],
        ["workItems", []],
        ["acceptanceCriteria", []],
      ],
      "evil-task",
    );
    await saver.put(
      { configurable: { thread_id: healthyThread } },
      checkpoint("checkpoint-healthy-neighbor", validWorkflowState()),
      { source: "input", step: -1, parents: {} },
      {},
    );

    const reopened = await FileCheckpointSaver.open(directory);
    await expect(reopened.getTuple({ configurable: { thread_id: invalidThread } })).rejects.toThrow(
      "checkpoint is corrupt",
    );
    expect(await reopened.getTuple({ configurable: { thread_id: healthyThread } })).toBeDefined();
    expect(reopened.quarantinedFiles).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function checkpoint(id: string, channelValues: Record<string, unknown>) {
  return {
    v: 1,
    id,
    ts: new Date(0).toISOString(),
    channel_values: channelValues,
    channel_versions: {},
    versions_seen: {},
  };
}

function validWorkflowState(): Record<string, unknown> {
  return {
    objective: "Review repository",
    pattern: "review",
    maxIterations: 0,
    approvalRequired: false,
    discoveryRound: 0,
    workItems: [],
    acceptanceCriteria: [],
    findings: [],
    changes: [],
    iteration: 0,
    phase: "classified",
    status: "running",
    summary: "",
    unresolvedRisks: [],
    trace: [],
  };
}

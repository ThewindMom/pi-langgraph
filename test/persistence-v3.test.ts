import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_VERSION, parseSerializedThread } from "../src/persistence/file-checkpoint-format.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { mutationKey } from "../src/persistence/mutation-journal.ts";
import { validateEffectiveWorkflowState } from "../src/persistence/workflow-pending-write-validation.ts";
import { validatePersistedWorkflowChannels } from "../src/persistence/workflow-state-validation.ts";

const digest = "a".repeat(64);

test("uses scoped v3 mutation identity while retaining legacy operation keys", () => {
  // Given: one legacy operation and scoped attempts for one planned change.
  const legacy = { kind: "implement" as const, iteration: 0 };
  const scoped = {
    kind: "repair" as const,
    iteration: 2,
    workspaceId: "workspace-1",
    planId: "plan-1",
    changeId: "change-a",
    attempt: 2,
  };
  const identity = createHash("sha256").update("workspace-1\0plan-1\0change-a").digest("hex");

  // When: mutation keys are derived.
  const legacyKey = mutationKey(legacy);
  const scopedKey = mutationKey(scoped);

  // Then: old callers retain their key and scoped attempts use the canonical v3 identity.
  expect(legacyKey).toBe("implement:0");
  expect(scopedKey).toBe(`v3:${identity}:repair:2`);
  expect(mutationKey({ ...scoped, attempt: 3 })).not.toBe(scopedKey);
  expect(() => mutationKey({ ...legacy, workspaceId: "workspace-1" })).toThrow();
});

test("reads v2 global mutation journals and emits the current file version", () => {
  // Given: a checkpoint file written by the v2 global mutation journal.
  const raw = JSON.stringify({
    version: 2,
    threadId: "legacy-thread",
    storage: {},
    writes: {},
    mutations: { "implement:0": { status: "completed", output: "done" } },
  });

  // When: the current parser loads it.
  const parsed = parseSerializedThread(raw, "legacy.checkpoint.json");

  // Then: source provenance is retained and future persistence uses v3.
  expect(parsed.sourceVersion).toBe(2);
  expect(parsed.version).toBe(FILE_VERSION);
  expect(parsed.mutations["implement:0"]).toEqual({ status: "completed", output: "done" });
});

test("keeps structurally valid v3 checkpoints inspectable without replay binding", () => {
  // Given: metadata-free storage written by the previous v3 format.
  const raw = JSON.stringify({
    version: 3,
    threadId: "legacy-v3-thread",
    storage: {},
    writes: {},
    mutations: {},
  });

  // When: the current parser loads the old file.
  const parsed = parseSerializedThread(raw, "legacy-v3.checkpoint.json");

  // Then: provenance is retained without inventing replay data.
  expect(parsed.sourceVersion).toBe(3);
  expect(parsed.version).toBe(FILE_VERSION);
  expect("replayBinding" in parsed).toBe(false);
});

test("replays a scoped change mutation after a file-saver restart", async () => {
  // Given: a completed scoped mutation claim for one workspace plan change.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-scoped-mutation-"));
  const operation = {
    kind: "implement" as const,
    iteration: 0,
    workspaceId: "workspace-1",
    planId: "plan-1",
    changeId: "change-a",
    attempt: 1,
  };
  try {
    const saver = await FileCheckpointSaver.open(root);
    expect(await saver.claimMutation("scoped-mutation", operation)).toEqual({ status: "execute" });
    await saver.completeMutation("scoped-mutation", operation, "applied change A");

    // When: the mutation is claimed through a new saver instance.
    const reopened = await FileCheckpointSaver.open(root);
    const claim = await reopened.claimMutation("scoped-mutation", operation);

    // Then: the durable scoped identity replays its completed output.
    expect(claim).toEqual({ status: "replay", output: "applied change A" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists typed per-change workflow state across a file-saver restart", async () => {
  // Given: a valid checkpoint containing every optional v3 workflow channel.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-persistence-v3-"));
  const state = workflowStateWithV3Channels();
  try {
    const saver = await FileCheckpointSaver.open(root);
    await saver.put(
      { configurable: { thread_id: "typed-change-state" } },
      checkpoint("checkpoint-v3", state),
      { source: "input", step: -1, parents: {} },
      {},
    );

    // When: a new saver instance loads the persisted thread.
    const reopened = await FileCheckpointSaver.open(root);
    const tuple = await reopened.getTuple({ configurable: { thread_id: "typed-change-state" } });

    // Then: plan, change result, evidence, and interrupt state survive validation and hydration.
    expect(tuple?.checkpoint.channel_values.plan).toEqual(state.plan);
    expect(tuple?.checkpoint.channel_values.changeResults).toEqual(state.changeResults);
    expect(tuple?.checkpoint.channel_values.evidenceRefs).toEqual(state.evidenceRefs);
    expect(tuple?.checkpoint.channel_values.interrupt).toEqual(state.interrupt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects malformed v3 channels in checkpoints and pending writes", () => {
  // Given: otherwise valid state with malformed artifact identity.
  const state = workflowStateWithV3Channels();
  const invalidRef = { digest: "sha256:not-a-digest", byteCount: 1, truncated: false };

  // When/Then: both checkpoint and pending-write boundaries reject it.
  expect(() => validatePersistedWorkflowChannels({ ...state, evidenceRefs: [invalidRef] })).toThrow(
    "invalid persisted workflow evidenceRefs[0].digest",
  );
  expect(() => validateEffectiveWorkflowState(baseWorkflowState(), [
    { channel: "evidenceRefs", value: [invalidRef] },
  ])).toThrow("invalid persisted workflow evidenceRefs[0].digest");
});

function workflowStateWithV3Channels(): Record<string, unknown> {
  const artifact = { digest, byteCount: 42, truncated: false };
  const change = {
    changeId: "change-a",
    title: "Change A",
    instruction: "Implement change A",
    dependsOn: [],
    scope: { files: ["src/a.ts"] },
    risk: { level: "high", reasons: ["production scope"] },
    acceptanceChecks: [{ kind: "package_script", script: "test" }],
    status: "claimed",
  };
  return {
    ...baseWorkflowState(),
    plan: { version: 1, planId: "plan-1", revision: 1, changes: [change] },
    changeResults: [{
      changeId: "change-a",
      status: "running",
      attempt: 1,
      evidenceRefs: [artifact],
    }],
    evidenceRefs: [artifact],
    interrupt: {
      interruptId: "interrupt-1",
      changeId: "change-a",
      planId: "plan-1",
      revision: 1,
      reasons: ["production scope"],
      scope: { files: ["src/a.ts"] },
    },
  };
}

function baseWorkflowState(): Record<string, unknown> {
  return {
    objective: "Implement a planned change",
    pattern: "delivery",
    maxIterations: 1,
    approvalRequired: true,
    discoveryRound: 1,
    workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
    acceptanceCriteria: ["tests pass"],
    findings: [],
    changes: [],
    iteration: 0,
    phase: "analyzed",
    status: "awaiting_approval",
    summary: "",
    unresolvedRisks: [],
    trace: [],
  };
}

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

import { describe, expect, test } from "bun:test";
import {
  ReplayCompatibilityError,
  parseReplayFingerprintBinding,
  replayFingerprint,
} from "../src/workflow/replay-compatibility.ts";

const binding = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  bridgeProtocolVersion: 1,
  workflowVersion: 2,
  stateVersion: 3,
  checkpoint: {
    threadId: "thread-01",
    checkpointId: "checkpoint-02",
    lineage: ["checkpoint-01", "checkpoint-02"],
  },
  workflowInput: { objective: "add replay protection", approval: "none" },
  repositorySnapshot: { snapshotId: "a".repeat(64), baselineHead: "b".repeat(40) },
  toolModelConfigDigest: "c".repeat(64),
  effectLedgerDigest: "d".repeat(64),
  ...overrides,
});

describe("replay compatibility", () => {
  test("stable canonical fingerprint when equivalent inputs reorder keys", () => {
    // Given: equivalent workflow input values with a fixed exact checkpoint lineage.
    const first = binding();
    const second = binding({ workflowInput: { approval: "none", objective: "add replay protection" } });

    // When: each complete replay binding is fingerprinted.
    const firstFingerprint = replayFingerprint(first);
    const secondFingerprint = replayFingerprint(second);

    // Then: key order cannot alter the durable compatibility identity.
    expect(secondFingerprint).toBe(firstFingerprint);
  });

  test("changes fingerprint when checkpoint lineage snapshot or effect ledger changes", () => {
    // Given: one valid replay binding and independently changed compatibility inputs.
    const baseline = replayFingerprint(binding());
    const changedLineage = replayFingerprint(binding({ checkpoint: {
      threadId: "thread-01", checkpointId: "checkpoint-02", lineage: ["checkpoint-00", "checkpoint-02"],
    } }));
    const changedSnapshot = replayFingerprint(binding({ repositorySnapshot: { snapshotId: "e".repeat(64), baselineHead: "b".repeat(40) } }));
    const changedEffects = replayFingerprint(binding({ effectLedgerDigest: "f".repeat(64) }));

    // When / Then: each exact compatibility dependency changes the fingerprint.
    expect(changedLineage).not.toBe(baseline);
    expect(changedSnapshot).not.toBe(baseline);
    expect(changedEffects).not.toBe(baseline);
  });

  test("rejects malformed bindings and non-terminal checkpoint lineages", () => {
    // Given: invalid untrusted input at the replay boundary.
    const malformed = binding({ extra: true });
    const nonTerminalLineage = binding({ checkpoint: {
      threadId: "thread-01", checkpointId: "checkpoint-02", lineage: ["checkpoint-02", "checkpoint-01"],
    } });

    // When / Then: strict parsing never silently creates a replay identity.
    expect(() => parseReplayFingerprintBinding(malformed)).toThrow(ReplayCompatibilityError);
    expect(() => parseReplayFingerprintBinding(nonTerminalLineage)).toThrow(ReplayCompatibilityError);
  });
});

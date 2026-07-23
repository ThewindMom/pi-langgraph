import { describe, expect, test } from "bun:test";
import {
  BridgeContractError,
  canonicalJson,
  decodeBacktrackRequest,
  decodeSessionCheckpointLink,
  encodeSessionCheckpointLink,
  piCheckpointDisplayLabel,
  sha256CanonicalJson,
} from "../src/bridge/codec.ts";
import type { SessionCheckpointLinkV1 } from "../src/bridge/types.ts";

describe("session checkpoint bridge contract", () => {
  test("round-trips a versioned link without a managed worktree", () => {
    // Given: a dirty-safe snapshot whose baseline has no Git HEAD.
    const link = {
      protocolVersion: 1,
      entryType: "pi-langgraph/checkpoint-link",
      threadId: "thread-01",
      checkpointId: "checkpoint-01",
      label: "pre-mutation",
      repositorySnapshot: {
        protocolVersion: 1,
        snapshotId: "a".repeat(64),
        baselineHead: null,
      },
      replayFingerprint: "b".repeat(64),
      effectLedgerDigest: "c".repeat(64),
    } satisfies SessionCheckpointLinkV1;

    // When: the durable payload is encoded and decoded.
    const decoded = decodeSessionCheckpointLink(encodeSessionCheckpointLink(link));

    // Then: its canonical structure is preserved without fabricating a worktree or commit.
    expect(decoded).toEqual(link);
    expect(canonicalJson(link)).toBe(encodeSessionCheckpointLink(link));
    expect(sha256CanonicalJson(link)).toBe("ef49c63141205bf5c0adb0ce036e1b210f4dcb8ed249d6731cb1e0222d6affd6");
    expect(piCheckpointDisplayLabel(decoded)).toBe("lg:pre-mutation:thread-01:checkpoint-0");
  });

  test("round-trips a managed fork without accepting candidate-only fields", () => {
    // Given: a fork-owned worktree reference bound to its isolated graph thread.
    const managedWorktree = {
      protocolVersion: 1,
      kind: "fork",
      forkThreadId: "pi-fork-01",
      path: "/tmp/pi-fork-01",
    } as const;
    const payload = {
      protocolVersion: 1,
      entryType: "pi-langgraph/checkpoint-link",
      threadId: managedWorktree.forkThreadId,
      checkpointId: "checkpoint-01",
      label: "pre-mutation",
      repositorySnapshot: {
        protocolVersion: 1,
        snapshotId: "a".repeat(64),
        baselineHead: "d".repeat(40),
      },
      managedWorktree,
      replayFingerprint: "b".repeat(64),
      effectLedgerDigest: "c".repeat(64),
    } satisfies SessionCheckpointLinkV1;

    // When: the link crosses the strict codec boundary.
    const decoded = decodeSessionCheckpointLink(encodeSessionCheckpointLink(payload));

    // Then: the fork discriminator survives and candidate-only fields are rejected.
    expect(decoded).toEqual(payload);
    expect(() => decodeSessionCheckpointLink({
      ...payload,
      managedWorktree: { ...managedWorktree, candidateIndex: 0 },
    })).toThrow(BridgeContractError);
  });

  test("rejects incompatible bridge payloads", () => {
    // Given: valid baseline payload fields.
    const payload = {
      protocolVersion: 1,
      entryType: "pi-langgraph/checkpoint-link",
      threadId: "thread-01",
      checkpointId: "checkpoint-01",
      label: "last-known-green",
      repositorySnapshot: {
        protocolVersion: 1,
        snapshotId: "a".repeat(64),
        baselineHead: "d".repeat(40),
      },
      replayFingerprint: "b".repeat(64),
      effectLedgerDigest: "c".repeat(64),
    };

    // When / Then: forward versions, unknown fields, unsafe paths, invalid digests, and third candidates fail at the boundary.
    expect(() => decodeSessionCheckpointLink({ ...payload, protocolVersion: 2 })).toThrow(BridgeContractError);
    expect(() => decodeSessionCheckpointLink({ ...payload, extra: true })).toThrow(BridgeContractError);
    expect(() => decodeSessionCheckpointLink({ ...payload, replayFingerprint: "not-a-digest" })).toThrow(BridgeContractError);
    expect(() => decodeSessionCheckpointLink({
      ...payload,
      managedWorktree: {
        protocolVersion: 1,
        kind: "candidate",
        candidateIndex: 2,
        worktreeId: "candidate-2",
        path: "/tmp/candidate-2",
      },
    })).toThrow(BridgeContractError);
    expect(() => decodeSessionCheckpointLink({
      ...payload,
      managedWorktree: {
        protocolVersion: 1,
        kind: "candidate",
        candidateIndex: 0,
        worktreeId: "candidate-0",
        path: "../outside-manager-root",
      },
    })).toThrow(BridgeContractError);
    expect(() => decodeBacktrackRequest({
      protocolVersion: 1,
      requestId: "request-01",
      sessionId: "session-01",
      entryId: "entry-01",
      link: payload,
      candidateIndices: [0],
    })).toThrow(BridgeContractError);
  });
});

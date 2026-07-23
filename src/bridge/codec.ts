import {
  canonicalJson,
  sha256CanonicalJson,
} from "./canonical.ts";
import {
  blockedReason,
  candidate,
  digest,
  fail,
  gitHead,
  identifier,
  managedPath,
  managedWorktreeId,
  parseEncodedPayload,
  rejectedReason,
  requireExactFields,
  requireRecord,
  requireVersion,
  semanticLabel,
} from "./contract-validation.ts";
import {
  BRIDGE_PROTOCOL_VERSION,
  PI_CHECKPOINT_LINK_ENTRY_TYPE,
  type BacktrackRequestV1,
  type BacktrackOutcomeV1,
  type ManagedWorktreeRefV1,
  type RepositorySnapshotRefV1,
  type SessionCheckpointLinkV1,
} from "./types.ts";

export { BridgeContractError } from "./types.ts";
export { canonicalJson, sha256CanonicalJson } from "./canonical.ts";


export function encodeSessionCheckpointLink(link: SessionCheckpointLinkV1): string {
  return canonicalJson(link);
}

export function piCheckpointDisplayLabel(link: SessionCheckpointLinkV1): string {
  return `lg:${link.label}:${link.threadId}:${link.checkpointId.slice(0, 12)}`;
}

export function decodeSessionCheckpointLink(value: unknown): SessionCheckpointLinkV1 {
  const record = requireRecord(parseEncodedPayload(value), "payload");
  requireExactFields(record, [
    "protocolVersion",
    "entryType",
    "threadId",
    "checkpointId",
    "label",
    "repositorySnapshot",
    "managedWorktree",
    "replayFingerprint",
    "effectLedgerDigest",
  ], ["managedWorktree"], "payload");
  requireVersion(record.protocolVersion, "protocolVersion");
  if (record.entryType !== PI_CHECKPOINT_LINK_ENTRY_TYPE) fail("invalid-payload", "entryType");
  const repositorySnapshot = decodeRepositorySnapshotRef(record.repositorySnapshot);
  const managedWorktree = record.managedWorktree === undefined
    ? undefined
    : decodeManagedWorktreeRef(record.managedWorktree);
  const link = {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    entryType: PI_CHECKPOINT_LINK_ENTRY_TYPE,
    threadId: identifier(record.threadId, "threadId"),
    checkpointId: identifier(record.checkpointId, "checkpointId"),
    label: semanticLabel(record.label),
    repositorySnapshot,
    replayFingerprint: digest(record.replayFingerprint, "replayFingerprint"),
    effectLedgerDigest: digest(record.effectLedgerDigest, "effectLedgerDigest"),
  } satisfies Omit<SessionCheckpointLinkV1, "managedWorktree">;
  return managedWorktree === undefined ? link : { ...link, managedWorktree };
}

export function decodeRepositorySnapshotRef(value: unknown): RepositorySnapshotRefV1 {
  const record = requireRecord(value, "repositorySnapshot");
  requireExactFields(record, ["protocolVersion", "snapshotId", "baselineHead"], [], "repositorySnapshot");
  requireVersion(record.protocolVersion, "repositorySnapshot.protocolVersion");
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    snapshotId: digest(record.snapshotId, "repositorySnapshot.snapshotId"),
    baselineHead: gitHead(record.baselineHead, "repositorySnapshot.baselineHead"),
  };
}

export function decodeBacktrackRequest(value: unknown): BacktrackRequestV1 {
  const record = requireRecord(parseEncodedPayload(value), "backtrackRequest");
  requireExactFields(
    record,
    ["protocolVersion", "requestId", "sessionId", "entryId", "link", "candidateIndices"],
    [],
    "backtrackRequest",
  );
  requireVersion(record.protocolVersion, "backtrackRequest.protocolVersion");
  if (!Array.isArray(record.candidateIndices) || record.candidateIndices.length !== 2) {
    fail("invalid-candidate-index", "backtrackRequest.candidateIndices");
  }
  if (record.candidateIndices[0] !== 0 || record.candidateIndices[1] !== 1) {
    fail("invalid-candidate-index", "backtrackRequest.candidateIndices");
  }
  return {
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    requestId: identifier(record.requestId, "backtrackRequest.requestId"),
    sessionId: identifier(record.sessionId, "backtrackRequest.sessionId"),
    entryId: identifier(record.entryId, "backtrackRequest.entryId"),
    link: decodeSessionCheckpointLink(record.link),
    candidateIndices: [0, 1],
  };
}

export function decodeBacktrackOutcome(value: unknown): BacktrackOutcomeV1 {
  const record = requireRecord(parseEncodedPayload(value), "backtrackOutcome");
  requireVersion(record.protocolVersion, "backtrackOutcome.protocolVersion");
  const requestId = identifier(record.requestId, "backtrackOutcome.requestId");
  switch (record.kind) {
    case "promoted":
      requireExactFields(record, ["protocolVersion", "kind", "requestId", "candidateIndex"], [], "backtrackOutcome");
      return { protocolVersion: BRIDGE_PROTOCOL_VERSION, kind: "promoted", requestId, candidateIndex: candidate(record.candidateIndex) };
    case "blocked":
      requireExactFields(record, ["protocolVersion", "kind", "requestId", "reason"], [], "backtrackOutcome");
      return { protocolVersion: BRIDGE_PROTOCOL_VERSION, kind: "blocked", requestId, reason: blockedReason(record.reason) };
    case "rejected":
      requireExactFields(record, ["protocolVersion", "kind", "requestId", "reason"], [], "backtrackOutcome");
      return { protocolVersion: BRIDGE_PROTOCOL_VERSION, kind: "rejected", requestId, reason: rejectedReason(record.reason) };
    default:
      fail("invalid-payload", "backtrackOutcome.kind");
  }
}

export function decodeManagedWorktreeRef(value: unknown): ManagedWorktreeRefV1 {
  const record = requireRecord(value, "managedWorktree");
  requireVersion(record.protocolVersion, "managedWorktree.protocolVersion");
  switch (record.kind) {
    case "candidate": {
      requireExactFields(
        record,
        ["protocolVersion", "kind", "candidateIndex", "worktreeId", "path"],
        [],
        "managedWorktree",
      );
      const candidateIndex = candidate(record.candidateIndex);
      const worktreeId = managedWorktreeId(record.worktreeId);
      if (worktreeId !== `candidate-${candidateIndex}`) {
        fail("invalid-identifier", "managedWorktree.worktreeId");
      }
      return {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        kind: "candidate",
        candidateIndex,
        worktreeId,
        path: managedPath(record.path),
      };
    }
    case "fork":
      requireExactFields(
        record,
        ["protocolVersion", "kind", "forkThreadId", "path"],
        [],
        "managedWorktree",
      );
      return {
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        kind: "fork",
        forkThreadId: identifier(record.forkThreadId, "managedWorktree.forkThreadId"),
        path: managedPath(record.path),
      };
    default:
      fail("invalid-payload", "managedWorktree.kind");
  }
}

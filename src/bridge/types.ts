declare const bridgeBrand: unique symbol;

export type BridgeBrand<Name extends string> = string & {
  readonly [bridgeBrand]?: Name;
};

export type SessionId = BridgeBrand<"SessionId">;
export type PiSessionEntryId = BridgeBrand<"PiSessionEntryId">;
export type LangGraphThreadId = BridgeBrand<"LangGraphThreadId">;
export type LangGraphCheckpointId = BridgeBrand<"LangGraphCheckpointId">;
export type RepositorySnapshotId = BridgeBrand<"RepositorySnapshotId">;
export type GitHead = BridgeBrand<"GitHead">;
export type ReplayFingerprint = BridgeBrand<"ReplayFingerprint">;
export type EffectLedgerDigest = BridgeBrand<"EffectLedgerDigest">;
export type BacktrackRequestId = BridgeBrand<"BacktrackRequestId">;
export type ManagedWorktreeId = BridgeBrand<"ManagedWorktreeId">;

export const PI_CHECKPOINT_LINK_ENTRY_TYPE = "pi-langgraph/checkpoint-link" as const;
export const BRIDGE_PROTOCOL_VERSION = 1 as const;

export const SEMANTIC_CHECKPOINT_LABELS = [
  "post-discovery",
  "pre-mutation",
  "last-known-green",
  "post-repair",
] as const;

export type SemanticCheckpointLabel = (typeof SEMANTIC_CHECKPOINT_LABELS)[number];
export type CandidateIndex = 0 | 1;

export type RepositorySnapshotRefV1 = Readonly<{
  protocolVersion: 1;
  snapshotId: RepositorySnapshotId;
  baselineHead: GitHead | null;
}>;

export type CandidateManagedWorktreeRefV1 = Readonly<{
  protocolVersion: 1;
  kind: "candidate";
  candidateIndex: CandidateIndex;
  worktreeId: ManagedWorktreeId;
  path: string;
}>;

export type ForkManagedWorktreeRefV1 = Readonly<{
  protocolVersion: 1;
  kind: "fork";
  forkThreadId: LangGraphThreadId;
  path: string;
}>;

export type ManagedWorktreeRefV1 =
  | CandidateManagedWorktreeRefV1
  | ForkManagedWorktreeRefV1;

export type SessionCheckpointLinkV1 = Readonly<{
  protocolVersion: 1;
  entryType: typeof PI_CHECKPOINT_LINK_ENTRY_TYPE;
  threadId: LangGraphThreadId;
  checkpointId: LangGraphCheckpointId;
  label: SemanticCheckpointLabel;
  repositorySnapshot: RepositorySnapshotRefV1;
  managedWorktree?: ManagedWorktreeRefV1;
  replayFingerprint: ReplayFingerprint;
  effectLedgerDigest: EffectLedgerDigest;
}>;

export type BacktrackRequestV1 = Readonly<{
  protocolVersion: 1;
  requestId: BacktrackRequestId;
  sessionId: SessionId;
  entryId: PiSessionEntryId;
  link: SessionCheckpointLinkV1;
  candidateIndices: readonly [0, 1];
}>;

export type BacktrackOutcomeV1 =
  | Readonly<{
    protocolVersion: 1;
    kind: "promoted";
    requestId: BacktrackRequestId;
    candidateIndex: CandidateIndex;
  }>
  | Readonly<{
    protocolVersion: 1;
    kind: "blocked";
    requestId: BacktrackRequestId;
    reason: "incompatible-replay" | "unsafe-effects" | "source-changed";
  }>
  | Readonly<{
    protocolVersion: 1;
    kind: "rejected";
    requestId: BacktrackRequestId;
    reason: "invalid-request" | "missing-link";
  }>;

export type BridgeContractErrorCode =
  | "invalid-payload"
  | "unsupported-version"
  | "unknown-field"
  | "invalid-identifier"
  | "invalid-path"
  | "invalid-candidate-index"
  | "invalid-digest";

export class BridgeContractError extends Error {
  readonly name = "BridgeContractError";

  constructor(
    readonly code: BridgeContractErrorCode,
    readonly field: string,
  ) {
    super(`invalid bridge ${field}: ${code}`);
  }
}

export class ReplayIncompatibilityError extends Error {
  readonly name = "ReplayIncompatibilityError";

  constructor(readonly reason: "missing-fingerprint" | "fingerprint-mismatch" | "legacy-protocol") {
    super(`replay is incompatible: ${reason}`);
  }
}

export class PromotionBlockedError extends Error {
  readonly name = "PromotionBlockedError";

  constructor(readonly reason: "unsafe-effects" | "source-changed" | "already-promoted") {
    super(`promotion is blocked: ${reason}`);
  }
}

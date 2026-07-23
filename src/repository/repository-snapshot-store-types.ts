export type StoredRepositorySnapshot = Readonly<{
  protocolVersion: 1;
  snapshotId: string;
  baselineHead: string | null;
  dirty: boolean;
}>;

export type RepositorySnapshotTarget = Readonly<{
  kind: "empty-directory" | "managed-worktree";
  managerRoot: string;
  destination: string;
}>;

export type RepositorySnapshotStoreErrorCode =
  | "corrupt-snapshot"
  | "destination-not-empty"
  | "snapshot-missing"
  | "source-changed"
  | "unsafe-destination"
  | "unsafe-entry"
  | "unsafe-store";

export class RepositorySnapshotStoreError extends Error {
  readonly code: RepositorySnapshotStoreErrorCode;

  constructor(code: RepositorySnapshotStoreErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RepositorySnapshotStoreError";
    this.code = code;
  }
}

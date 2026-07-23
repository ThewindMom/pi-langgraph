import type { ManagedWorktreeRefV1, SessionCheckpointLinkV1 } from "./types.ts";

export type PiSessionEntry = Readonly<{
  type: string;
  id: string;
  parentId: string | null;
  customType?: string;
  data?: unknown;
}>;

export interface PiSessionReader {
  getSessionId(): string;
  getLeafId(): string | null;
  getEntry(id: string): PiSessionEntry | undefined;
  getEntries(): readonly PiSessionEntry[];
}

export interface PiCheckpointHost {
  appendEntry(customType: string, data?: unknown): void;
  setLabel(entryId: string, label: string): void;
}

export interface BridgeResourceResolver {
  checkpointExists(link: SessionCheckpointLinkV1): Promise<boolean>;
  managedWorktreeExists(worktree: ManagedWorktreeRefV1): Promise<boolean>;
}

export type ResolvedCheckpointLink = Readonly<{
  sessionId: string;
  entryId: string;
  link: SessionCheckpointLinkV1;
}>;

export type PiSessionBridgeErrorCode =
  | "append-failed"
  | "conflicting-link"
  | "malformed-link"
  | "malformed-session"
  | "missing-link"
  | "missing-target"
  | "not-ready"
  | "stale-link"
  | "stale-worktree";

export class PiSessionBridgeError extends Error {
  readonly name = "PiSessionBridgeError";

  constructor(
    readonly code: PiSessionBridgeErrorCode,
    readonly entryId: string,
  ) {
    super(`Pi session checkpoint bridge failed for ${JSON.stringify(entryId)}: ${code}`);
  }
}

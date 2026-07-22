import { isAbsolute } from "node:path";

export type CreateForkInput = Readonly<{
  sourceCwd: string;
  sourceThreadId: string;
  checkpointId: string;
  gitCommit: string;
  forkThreadId: string;
}>;

export type ForkManifest = Readonly<{
  protocolVersion: 1;
  nonce: string;
  sourceRepositoryRoot: string;
  sourceHead: string;
  sourceThreadId: string;
  checkpointId: string;
  gitCommit: string;
  forkThreadId: string;
  workspacePath: string;
}>;

export class WorktreeManagerError extends Error {
  readonly name = "WorktreeManagerError";

  constructor(
    readonly code:
      | "invalid_input"
      | "invalid_manifest"
      | "dirty_source"
      | "invalid_checkpoint"
      | "git_failure"
      | "fork_conflict"
      | "unsafe_cleanup",
    message: string,
  ) {
    super(message);
  }
}

const LEXICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NONCE = /^[0-9a-f]{32}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;

export function validateLexicalId(value: string, label: string): void {
  if (!LEXICAL_ID.test(value)) {
    throw new WorktreeManagerError("invalid_input", `${label} must be a lexical identifier`);
  }
}

export function validateObjectId(value: string, label: string): void {
  if (!OBJECT_ID.test(value)) {
    throw new WorktreeManagerError("invalid_checkpoint", `${label} must be a full Git object ID`);
  }
}

export function serializeManifest(manifest: ForkManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
}

export function parseManifest(bytes: Uint8Array): ForkManifest {
  if (bytes.byteLength > MAX_MANIFEST_BYTES) invalidManifest();
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError) invalidManifest();
    throw error;
  }
  if (typeof value !== "object" || value === null) invalidManifest();
  if (
    !("protocolVersion" in value) || value.protocolVersion !== 1 ||
    !("nonce" in value) || typeof value.nonce !== "string" || !NONCE.test(value.nonce) ||
    !("sourceRepositoryRoot" in value) || typeof value.sourceRepositoryRoot !== "string" || !isAbsolute(value.sourceRepositoryRoot) ||
    !("sourceHead" in value) || typeof value.sourceHead !== "string" || !OBJECT_ID.test(value.sourceHead) ||
    !("sourceThreadId" in value) || typeof value.sourceThreadId !== "string" || !LEXICAL_ID.test(value.sourceThreadId) ||
    !("checkpointId" in value) || typeof value.checkpointId !== "string" || !LEXICAL_ID.test(value.checkpointId) ||
    !("gitCommit" in value) || typeof value.gitCommit !== "string" || !OBJECT_ID.test(value.gitCommit) ||
    !("forkThreadId" in value) || typeof value.forkThreadId !== "string" || !LEXICAL_ID.test(value.forkThreadId) ||
    !("workspacePath" in value) || typeof value.workspacePath !== "string" || !isAbsolute(value.workspacePath)
  ) invalidManifest();
  return Object.freeze({
    protocolVersion: 1,
    nonce: value.nonce,
    sourceRepositoryRoot: value.sourceRepositoryRoot,
    sourceHead: value.sourceHead,
    sourceThreadId: value.sourceThreadId,
    checkpointId: value.checkpointId,
    gitCommit: value.gitCommit,
    forkThreadId: value.forkThreadId,
    workspacePath: value.workspacePath,
  });
}

function invalidManifest(): never {
  throw new WorktreeManagerError("invalid_manifest", "invalid worktree manifest");
}

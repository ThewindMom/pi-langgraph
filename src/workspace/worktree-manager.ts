import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  type CreateForkInput,
  type ForkManifest,
  parseManifest,
  serializeManifest,
  validateLexicalId,
  validateObjectId,
  WorktreeManagerError,
} from "./format.ts";

type GitResult = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

export function git(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    exitCode: result.status ?? 1,
  };
}

export function gitOutput(cwd: string, args: readonly string[], operation: string): string {
  const result = git(cwd, args);
  if (result.exitCode !== 0) {
    throw new WorktreeManagerError("git_failure", `${operation}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export async function ensurePrivateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorktreeManagerError("invalid_input", `worktree manager path is not an owned directory: ${path}`);
  }
  await chmod(path, 0o700);
  return realpath(path);
}

async function readManifest(path: string): Promise<ForkManifest | undefined> {
  return readWorkspaceManifest(path, parseManifest, "worktree manifest is not a regular file");
}

export async function readWorkspaceManifest<T>(
  path: string,
  parse: (bytes: Uint8Array) => T,
  invalidMessage: string,
): Promise<T | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new WorktreeManagerError("invalid_manifest", invalidMessage);
    }
    return parse(await readFile(path));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replaceWorkspaceManifest(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  await chmod(path, 0o600);
  await syncDirectory(dirname(path));
}

export async function removeWorkspaceManifest(path: string): Promise<void> {
  await unlink(path);
  await syncDirectory(dirname(path));
}

function isRegistered(repositoryRoot: string, workspacePath: string): boolean {
  const output = gitOutput(repositoryRoot, ["worktree", "list", "--porcelain", "-z"], "unable to list Git worktrees");
  return output.split("\0").includes(`worktree ${workspacePath}`);
}

async function publishManifest(path: string, manifest: ForkManifest): Promise<void> {
  const temporary = join(dirname(path), `.pending-${manifest.forkThreadId}-${manifest.nonce}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(serializeManifest(manifest));
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    if (hasCode(error, "EEXIST")) {
      throw new WorktreeManagerError("fork_conflict", `fork already exists: ${manifest.forkThreadId}`);
    }
    throw error;
  }
  await unlink(temporary);
  await chmod(path, 0o600);
  await syncDirectory(dirname(path));
}

export class WorktreeManager {
  private constructor(
    private readonly manifestsRoot: string,
    private readonly workspacesRoot: string,
  ) {}

  static async open(extensionRoot: string): Promise<WorktreeManager> {
    const root = await ensurePrivateDirectory(resolve(extensionRoot));
    const manifestsRoot = await ensurePrivateDirectory(join(root, "manifests"));
    const workspacesRoot = await ensurePrivateDirectory(join(root, "workspaces"));
    return new WorktreeManager(manifestsRoot, workspacesRoot);
  }

  async createFork(input: CreateForkInput): Promise<ForkManifest> {
    validateLexicalId(input.sourceThreadId, "source thread ID");
    validateLexicalId(input.forkThreadId, "fork thread ID");
    validateLexicalId(input.checkpointId, "checkpoint ID");
    validateObjectId(input.gitCommit, "Git commit");
    const repositoryRoot = await realpath(gitOutput(input.sourceCwd, ["rev-parse", "--show-toplevel"], "source is not a Git repository"));
    const sourceHead = gitOutput(repositoryRoot, ["rev-parse", "--verify", "HEAD"], "source has no retained HEAD");
    validateObjectId(sourceHead, "source HEAD");
    const status = gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "unable to inspect source status");
    if (status.length > 0) throw new WorktreeManagerError("dirty_source", "source Git repository must be clean, including untracked files");
    const checkpointResult = git(repositoryRoot, ["rev-parse", "--verify", `${input.gitCommit}^{commit}`]);
    if (checkpointResult.exitCode !== 0) {
      throw new WorktreeManagerError("invalid_checkpoint", "checkpoint is not a retained Git commit");
    }
    const gitCommit = checkpointResult.stdout.trim();
    validateObjectId(gitCommit, "Git commit");
    if (git(repositoryRoot, ["merge-base", "--is-ancestor", gitCommit, sourceHead]).exitCode !== 0) {
      throw new WorktreeManagerError("invalid_checkpoint", "Git commit is not retained by source HEAD");
    }

    const manifestPath = join(this.manifestsRoot, `${input.forkThreadId}.json`);
    const existing = await readManifest(manifestPath);
    if (existing !== undefined) {
      const expectedPath = join(this.workspacesRoot, `${input.forkThreadId}-${existing.nonce}`);
      const matches = existing.sourceRepositoryRoot === repositoryRoot &&
        existing.sourceHead === sourceHead && existing.sourceThreadId === input.sourceThreadId &&
        existing.checkpointId === input.checkpointId && existing.gitCommit === gitCommit &&
        existing.forkThreadId === input.forkThreadId && existing.workspacePath === expectedPath;
      if (matches && isRegistered(repositoryRoot, existing.workspacePath) && await pathExists(existing.workspacePath)) return existing;
      throw new WorktreeManagerError("fork_conflict", `fork already exists: ${input.forkThreadId}`);
    }

    const nonce = randomBytes(16).toString("hex");
    const workspacePath = join(this.workspacesRoot, `${input.forkThreadId}-${nonce}`);
    const manifest = Object.freeze({
      protocolVersion: 1,
      nonce,
      sourceRepositoryRoot: repositoryRoot,
      sourceHead,
      sourceThreadId: input.sourceThreadId,
      checkpointId: input.checkpointId,
      gitCommit,
      forkThreadId: input.forkThreadId,
      workspacePath,
    } satisfies ForkManifest);
    await publishManifest(manifestPath, manifest);
    const added = git(repositoryRoot, ["worktree", "add", "--detach", workspacePath, gitCommit]);
    if (added.exitCode !== 0) {
      if (!await pathExists(workspacePath)) await unlink(manifestPath);
      throw new WorktreeManagerError("git_failure", `unable to create Git worktree: ${added.stderr.trim()}`);
    }
    await chmod(workspacePath, 0o700);
    const currentHead = gitOutput(repositoryRoot, ["rev-parse", "--verify", "HEAD"], "unable to recheck source HEAD");
    const currentStatus = gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"], "unable to recheck source status");
    if (currentHead !== sourceHead || currentStatus.length > 0) {
      await this.cleanup(input.forkThreadId);
      throw new WorktreeManagerError("git_failure", "source repository changed while creating fork");
    }
    return manifest;
  }

  async getFork(forkThreadId: string): Promise<ForkManifest | undefined> {
    validateLexicalId(forkThreadId, "fork thread ID");
    return readManifest(join(this.manifestsRoot, `${forkThreadId}.json`));
  }

  async cleanup(forkThreadId: string): Promise<void> {
    validateLexicalId(forkThreadId, "fork thread ID");
    const manifestPath = join(this.manifestsRoot, `${forkThreadId}.json`);
    const manifest = await readManifest(manifestPath);
    if (manifest === undefined) return;
    const expectedPath = join(this.workspacesRoot, `${forkThreadId}-${manifest.nonce}`);
    if (manifest.forkThreadId !== forkThreadId || manifest.workspacePath !== expectedPath || dirname(expectedPath) !== this.workspacesRoot) {
      throw new WorktreeManagerError("unsafe_cleanup", "manifest does not own its claimed workspace path");
    }
    if (await pathExists(expectedPath)) {
      const info = await lstat(expectedPath);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new WorktreeManagerError("unsafe_cleanup", "owned workspace path is not a real directory");
      }
    }
    if (isRegistered(manifest.sourceRepositoryRoot, expectedPath)) {
      gitOutput(manifest.sourceRepositoryRoot, ["worktree", "remove", "--force", expectedPath], "unable to remove owned Git worktree");
    } else if (await pathExists(expectedPath)) {
      throw new WorktreeManagerError("unsafe_cleanup", "refusing to delete an unregistered workspace path");
    }
    await unlink(manifestPath);
    await syncDirectory(this.manifestsRoot);
  }
}

export type { CreateForkInput, ForkManifest } from "./format.ts";
export { WorktreeManagerError } from "./format.ts";

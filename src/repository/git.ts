import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";

export type GitResult = Readonly<{ stdout: string; exitCode: number }>;

export function runGit(cwd: string, args: readonly string[]): GitResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    stdout: result.stdout ?? "",
    exitCode: result.status ?? 1,
  };
}

export async function getRepositoryRoot(cwd: string): Promise<string> {
  if (cwd.includes("\0")) throw new Error("unsafe repository path");
  const requested = resolve(cwd);
  const result = runGit(requested, ["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) throw new Error(`Not a Git repository: ${requested}`);
  const root = await realpath(result.stdout.trim());
  const info = await stat(root);
  if (!info.isDirectory() || !root.startsWith("/")) throw new Error("unsafe repository root");
  return root;
}

export function getRepositoryHead(cwd: string): string | null {
  const result = runGit(cwd, ["rev-parse", "HEAD"]);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export function getRepositoryStatus(cwd: string): string {
  const result = runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (result.exitCode !== 0) throw new Error("Unable to inspect Git status");
  return result.stdout;
}

export function getTrackedDiff(cwd: string): string {
  const result = runGit(cwd, ["diff", "HEAD", "--binary", "--no-ext-diff", "--"]);
  if (result.exitCode === 0) return result.stdout;
  const initial = runGit(cwd, ["diff", "--binary", "--no-ext-diff", "--"]);
  return initial.stdout;
}

export function getRepositoryPaths(cwd: string): string[] {
  const result = runGit(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (result.exitCode !== 0) throw new Error("Unable to list Git files");
  return result.stdout.split("\0").filter((path) => path.length > 0).sort();
}

export function getUntrackedPaths(cwd: string): string[] {
  const result = runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.exitCode !== 0) throw new Error("Unable to list untracked Git files");
  return result.stdout.split("\0").filter((path) => path.length > 0).sort();
}

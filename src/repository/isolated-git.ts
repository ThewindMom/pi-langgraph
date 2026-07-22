import { createHash } from "node:crypto";
import { cp, lstat, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { runGit } from "./git.ts";
import { RepositoryIsolationError } from "./isolation-error.ts";

export async function materializeGitDirectory(sourceRoot: string, isolatedRoot: string): Promise<void> {
  const sourceDotGit = join(sourceRoot, ".git");
  const info = await lstat(sourceDotGit);
  if (info.isDirectory()) return;
  const common = absoluteGitPath(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const git = absoluteGitPath(sourceRoot, ["rev-parse", "--absolute-git-dir"]);
  const isolatedGit = join(isolatedRoot, ".git");
  await rm(isolatedGit, { recursive: true, force: true });
  await cp(common, isolatedGit, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (git !== common) {
    await cp(git, isolatedGit, { recursive: true, force: true, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(join(isolatedGit, "commondir"), { force: true });
    await rm(join(isolatedGit, "gitdir"), { force: true });
  }
}

export function gitIndexIdentity(cwd: string): string | undefined {
  const result = runGit(cwd, ["ls-files", "--stage", "-z"]);
  return result.exitCode === 0 ? createHash("sha256").update(result.stdout).digest("hex") : undefined;
}

function absoluteGitPath(cwd: string, args: readonly string[]): string {
  const result = runGit(cwd, args);
  if (result.exitCode !== 0 || !isAbsolute(result.stdout.trim())) {
    throw new RepositoryIsolationError("source-conflict", "unable to isolate Git metadata");
  }
  return result.stdout.trim();
}

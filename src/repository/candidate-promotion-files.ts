import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getRepositoryPaths } from "./git.ts";

const MAX_FILE_BYTES = 256 * 1024 * 1024;
type FileIdentity = Readonly<{ digest: string; mode: number; size: number }> | undefined;

export class CandidatePromotionFileError extends Error {
  readonly name = "CandidatePromotionFileError";
}

export async function repositoryDelta(
  baselineRoot: string,
  candidateRoot: string,
): Promise<Readonly<{ paths: readonly string[]; bytes: number }>> {
  const paths = [...new Set([...getRepositoryPaths(baselineRoot), ...getRepositoryPaths(candidateRoot)])]
    .map(repositoryPath).sort();
  const changed: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const [before, after] = await Promise.all([
      fileIdentity(baselineRoot, path),
      fileIdentity(candidateRoot, path),
    ]);
    if (sameIdentity(before, after)) continue;
    changed.push(path);
    bytes += after?.size ?? 0;
  }
  return { paths: changed, bytes };
}

export async function applyDelta(
  targetRoot: string,
  sourceRoot: string,
  paths: readonly string[],
  beforePath?: (path: string, index: number) => Promise<void>,
  assertTargetBaseline?: (path: string) => Promise<void>,
): Promise<void> {
  for (const [index, path] of paths.entries()) {
    const source = join(sourceRoot, path);
    const target = join(targetRoot, path);
    const entry = await fileIdentity(sourceRoot, path);
    if (entry === undefined) {
      await beforePath?.(path, index);
      await assertTargetBaseline?.(path);
      await rm(target, { force: true });
      continue;
    }
    await ensureSafeParent(targetRoot, dirname(path));
    const temporary = `${target}.pi-promote-${randomUUID()}`;
    try {
      await copyFile(source, temporary);
      await chmod(temporary, entry.mode === 0 ? 0o644 : 0o755);
      await beforePath?.(path, index);
      await assertTargetBaseline?.(path);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function fileIdentity(root: string, path: string): Promise<FileIdentity> {
  try {
    const info = await lstat(join(root, path));
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) {
      throw new CandidatePromotionFileError(`unsafe candidate entry: ${path}`);
    }
    const content = await readFile(join(root, path));
    return {
      digest: createHash("sha256").update(content).digest("hex"),
      mode: info.mode & 0o111,
      size: content.length,
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function ensureSafeParent(root: string, path: string): Promise<void> {
  if (path === ".") return;
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new CandidatePromotionFileError(`unsafe publication parent: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current);
    }
  }
}

function repositoryPath(path: string): string {
  if (
    path.length === 0 || isAbsolute(path) || path.includes("\\") || path.includes("\0")
    || path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || path === ".git" || path.startsWith(".git/")
  ) throw new CandidatePromotionFileError(`unsafe repository path: ${path}`);
  return path;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left?.digest === right?.digest && left?.mode === right?.mode;
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

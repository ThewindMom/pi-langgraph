import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitIndexIdentity, materializeGitDirectory } from "./isolated-git.ts";
import { RepositoryIsolationError } from "./isolation-error.ts";
import { assertContainedSymlinks } from "./isolation-symlinks.ts";
import { SourceTreeTransaction } from "./source-tree-transaction.ts";

export { RepositoryIsolationError } from "./isolation-error.ts";

type EntryIdentity = Readonly<{ kind: "file" | "symlink" | "special"; digest: string; mode: number }>;
type TreeIdentity = ReadonlyMap<string, EntryIdentity>;
export type RepositoryExecutionMode = Readonly<{ kind: "read-only" }> | Readonly<{ kind: "mutation"; allowedFiles: readonly string[] | undefined }>;

export async function runInIsolatedRepository<T>(
  repositoryRoot: string,
  sourceCwd: string,
  mode: RepositoryExecutionMode,
  execute: (isolatedCwd: string) => Promise<T>,
  validateMutation?: (output: T, changedPaths: readonly string[]) => void,
): Promise<T> {
  const relativeCwd = relative(repositoryRoot, sourceCwd);
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`) || isAbsolute(relativeCwd)) {
    throw new RepositoryIsolationError("source-conflict", "worker directory escapes the repository");
  }
  const sourceTransaction = await SourceTreeTransaction.open(repositoryRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-langgraph-worker-"));
  const isolatedRoot = join(temporaryRoot, "repository");
  try {
    await sourceTransaction.copyBaselineTo(isolatedRoot);
    await materializeGitDirectory(repositoryRoot, isolatedRoot);
    const before = await captureTree(isolatedRoot);
    await assertContainedSymlinks(isolatedRoot, before, (path) => new RepositoryIsolationError("scope", `repository symlink escapes isolated workspace: ${path}`));
    const indexBefore = gitIndexIdentity(isolatedRoot);
    let output: T;
    try {
      output = await execute(resolve(isolatedRoot, relativeCwd));
    } catch (error) {
      await assertSourceUnchanged(sourceTransaction);
      if (mode.kind === "read-only") {
        assertAllowed(await semanticChanges(isolatedRoot, before, indexBefore), mode);
      }
      throw error;
    }
    await assertSourceUnchanged(sourceTransaction);
    const changed = await semanticChanges(isolatedRoot, before, indexBefore);
    assertAllowed(changed, mode);
    if (mode.kind === "mutation") {
      validateMutation?.(output, changed);
      await sourceTransaction.publish(
        changed,
        (candidateRoot) => publishChanges(candidateRoot, isolatedRoot, before, changed),
        (candidateRoot) => publishChanges(repositoryRoot, candidateRoot, before, changed),
      );
    }
    return output;
  } finally {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      sourceTransaction.close(),
    ]);
  }
}

async function assertSourceUnchanged(transaction: SourceTreeTransaction): Promise<void> {
  await transaction.assertSourceUnchanged((changed) => new RepositoryIsolationError(
    "source-conflict",
    `source changed while Pi worker ran; changes were preserved as an unattributable conflict: ${changed.join(", ")}`,
  ));
}

async function semanticChanges(
  root: string,
  before: TreeIdentity,
  indexBefore: string | undefined,
): Promise<readonly string[]> {
  const indexAfter = gitIndexIdentity(root);
  return changedPaths(before, await captureTree(root)).filter(
    (path) => path !== ".git/index" || indexBefore === undefined || indexBefore !== indexAfter,
  );
}

async function captureTree(root: string): Promise<TreeIdentity> {
  const entries = new Map<string, EntryIdentity>();
  await visit(root, "", entries);
  return entries;
}

async function visit(root: string, path: string, entries: Map<string, EntryIdentity>): Promise<void> {
  const absolute = path.length === 0 ? root : join(root, path);
  const children = await readdir(absolute, { withFileTypes: true });
  await Promise.all(children.map(async (child) => {
    const childPath = path.length === 0 ? child.name : `${path}/${child.name}`;
    if (child.isDirectory()) {
      await visit(root, childPath, entries);
      return;
    }
    const identity = await entryIdentity(root, childPath);
    if (identity === undefined) {
      throw new RepositoryIsolationError("source-conflict", `repository entry disappeared during isolation: ${childPath}`);
    }
    entries.set(childPath, identity);
  }));
}

async function entryIdentity(root: string, path: string): Promise<EntryIdentity | undefined> {
  try {
    const absolute = join(root, path);
    const info = await lstat(absolute);
    const kind = info.isFile() ? "file" : info.isSymbolicLink() ? "symlink" : "special";
    const content = kind === "file"
      ? await readFile(absolute)
      : kind === "symlink"
        ? Buffer.from(await readlink(absolute))
        : Buffer.from(`${info.dev}:${info.ino}:${info.size}`);
    return { kind, mode: info.mode, digest: createHash("sha256").update(content).digest("hex") };
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function changedPaths(before: TreeIdentity, after: TreeIdentity): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !sameEntry(before.get(path), after.get(path))).sort();
}

function sameEntry(left: EntryIdentity | undefined, right: EntryIdentity | undefined): boolean {
  return left?.kind === right?.kind && left?.mode === right?.mode && left?.digest === right?.digest;
}

function assertAllowed(changed: readonly string[], mode: RepositoryExecutionMode): void {
  if (changed.length === 0) return;
  if (mode.kind === "read-only") {
    throw new RepositoryIsolationError(
      "read-only",
      `read-only Pi worker mutated the repository; isolated output was rejected and was not cached: ${changed.join(", ")}`,
    );
  }
  const allowAll = mode.allowedFiles?.includes(".") === true;
  const allowed = new Set((mode.allowedFiles ?? []).filter((path) => path !== ".").map(parseRepositoryPath));
  const unexpected = changed.filter((path) => isGitPath(path) || (!allowAll && !allowed.has(path)));
  if (unexpected.length > 0) {
    throw new RepositoryIsolationError(
      "scope",
      `Pi worker mutated files outside its planned scope: ${unexpected.join(", ")}`,
    );
  }
}

function parseRepositoryPath(path: string): string {
  if (path.length === 0 || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new RepositoryIsolationError("scope", `unsafe planned mutation path: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new RepositoryIsolationError("scope", `unsafe planned mutation path: ${JSON.stringify(path)}`);
  }
  return path;
}

async function publishChanges(
  sourceRoot: string,
  isolatedRoot: string,
  baseline: TreeIdentity,
  changed: readonly string[],
): Promise<void> {
  await assertPublishableEntries(isolatedRoot, changed);
  for (const path of changed) {
    if (!sameEntry(baseline.get(path), await entryIdentity(sourceRoot, path))) {
      throw new RepositoryIsolationError("source-conflict", `source changed while Pi worker ran: ${path}`);
    }
  }
  for (const path of changed) await publishEntry(sourceRoot, isolatedRoot, path);
}

async function assertPublishableEntries(root: string, paths: readonly string[]): Promise<void> {
  const entries = new Map<string, EntryIdentity>();
  for (const path of paths) {
    const entry = await entryIdentity(root, path);
    if (entry !== undefined) entries.set(path, entry);
    if (entry?.kind === "special") {
      throw new RepositoryIsolationError("scope", `refusing to publish special file: ${path}`);
    }
  }
  await assertContainedSymlinks(root, entries, (path) => new RepositoryIsolationError("scope", `repository symlink escapes isolated workspace: ${path}`));
}

async function publishEntry(sourceRoot: string, isolatedRoot: string, path: string): Promise<void> {
  const source = join(sourceRoot, path);
  const isolated = join(isolatedRoot, path);
  const entry = await entryIdentity(isolatedRoot, path);
  if (entry === undefined) {
    await rm(source, { force: true });
    return;
  }
  if (entry.kind === "special") throw new RepositoryIsolationError("scope", `refusing to publish special file: ${path}`);
  await ensureSafeParent(sourceRoot, dirname(path));
  const temporary = `${source}.pi-langgraph-${randomUUID()}`;
  try {
    if (entry.kind === "symlink") await symlink(await readlink(isolated), temporary);
    else {
      await copyFile(isolated, temporary);
      await chmod(temporary, entry.mode);
    }
    await rename(temporary, source);
  } finally {
    await rm(temporary, { force: true });
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
        throw new RepositoryIsolationError("scope", `unsafe publication parent: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current);
    }
  }
}

function isGitPath(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

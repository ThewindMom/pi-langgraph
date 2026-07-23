import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../persistence/file-lock.ts";

const SOURCE_PUBLICATION_LOCK_KEY_PREFIX = "pi-langgraph-source-publication:";

type SourceEntry = Readonly<{
  kind: "directory" | "file" | "symlink" | "special";
  digest: string;
  mode: number;
}>;
type SourceTree = ReadonlyMap<string, SourceEntry>;

export class SourceTreeTransactionError extends Error {
  readonly operation: "snapshot" | "rollback";

  constructor(operation: SourceTreeTransactionError["operation"], message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "SourceTreeTransactionError";
    this.operation = operation;
  }
}

export class SourceTreeTransaction {
  private constructor(
    private readonly sourceRoot: string,
    private readonly transactionRoot: string,
    private readonly baselineRoot: string,
    private readonly baseline: SourceTree,
  ) {}

  static async open(sourceRoot: string): Promise<SourceTreeTransaction> {
    const canonicalRoot = await realpath(sourceRoot);
    const before = await captureTree(canonicalRoot);
    const transactionRoot = await mkdtemp(join(dirname(canonicalRoot), ".pi-langgraph-source-"));
    const baselineRoot = join(transactionRoot, "baseline");
    try {
      await cp(canonicalRoot, baselineRoot, copyOptions());
      const [after, baseline] = await Promise.all([captureTree(canonicalRoot), captureTree(baselineRoot)]);
      if (changedPaths(before, after).length > 0 || changedPaths(after, baseline).length > 0) {
        throw new SourceTreeTransactionError("snapshot", "source repository changed while its transaction snapshot was created");
      }
      return new SourceTreeTransaction(canonicalRoot, transactionRoot, baselineRoot, baseline);
    } catch (error) {
      await rm(transactionRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async copyBaselineTo(target: string): Promise<void> {
    await cp(this.baselineRoot, target, copyOptions());
  }

  async assertSourceUnchanged(fail: (changedPaths: readonly string[]) => Error): Promise<void> {
    const changed = changedPaths(this.baseline, await captureTree(this.sourceRoot));
    if (changed.length === 0) return;
    throw fail(changed);
  }

  async assertPathUnchanged(path: string, fail: (path: string) => Error): Promise<void> {
    if (sameEntry(this.baseline.get(path), await optionalSourceEntry(this.sourceRoot, path))) return;
    throw fail(path);
  }

  async publish(
    paths: readonly string[],
    stage: (candidateRoot: string) => Promise<void>,
    publishCandidate: (candidateRoot: string) => Promise<void>,
  ): Promise<void> {
    const candidateRoot = join(this.transactionRoot, "candidate");
    try {
      await cp(this.baselineRoot, candidateRoot, copyOptions());
      await stage(candidateRoot);
      const candidate = await captureTree(candidateRoot);
      await withFileLock(
        dirname(this.sourceRoot),
        `${SOURCE_PUBLICATION_LOCK_KEY_PREFIX}${this.sourceRoot}`,
        async () => {
          await this.assertSourceUnchanged((changed) => new SourceTreeTransactionError(
            "snapshot",
            `source repository changed before publication: ${changed.join(", ")}`,
          ));
          try {
            await publishCandidate(candidateRoot);
            const mismatched = changedPaths(candidate, await captureTree(this.sourceRoot));
            if (mismatched.length > 0) {
              throw new SourceTreeTransactionError(
                "snapshot",
                `published source tree does not match its staged snapshot: ${mismatched.join(", ")}`,
              );
            }
          } catch (error) {
            try {
              await this.rollbackPublished(paths, candidate);
            } catch (rollbackError) {
              throw new SourceTreeTransactionError(
                "rollback",
                "publication failed and the source repository could not be rolled back",
                rollbackError,
              );
            }
            throw error;
          }
        },
      );
    } finally {
      await rm(candidateRoot, { recursive: true, force: true });
    }
  }

  async close(): Promise<void> {
    await rm(this.transactionRoot, { recursive: true, force: true });
  }

  private async rollbackPublished(paths: readonly string[], candidate: SourceTree): Promise<void> {
    const current = await captureTree(this.sourceRoot);
    const owned = paths.filter((path) =>
      !sameEntry(this.baseline.get(path), candidate.get(path)) && sameEntry(current.get(path), candidate.get(path))
    );
    await this.restorePaths(owned);
    await this.cleanupCreatedParents(paths);
  }

  private async restorePaths(paths: readonly string[]): Promise<void> {
    const restore = minimalPaths(paths);
    try {
      for (const path of restore) await rm(join(this.sourceRoot, path), { recursive: true, force: true });
      for (const path of restore) {
        if (this.baseline.has(path)) {
          await cp(join(this.baselineRoot, path), join(this.sourceRoot, path), copyOptions());
        }
      }
      await this.cleanupCreatedParents(restore);
    } catch (error) {
      throw new SourceTreeTransactionError("rollback", "unable to restore source repository baseline", error);
    }
    const current = await captureTree(this.sourceRoot);
    const remaining = restore.filter((path) => !sameEntry(this.baseline.get(path), current.get(path)));
    if (remaining.length > 0) {
      throw new SourceTreeTransactionError(
        "rollback",
        `source repository rollback was incomplete: ${remaining.join(", ")}`,
      );
    }
  }

  private async cleanupCreatedParents(paths: readonly string[]): Promise<void> {
    const parents = createdParents(paths, this.baseline);
    for (const path of parents) {
      try {
        await rmdir(join(this.sourceRoot, path));
      } catch (error) {
        if (isMissingOrNotEmpty(error)) continue;
        throw error;
      }
    }
  }
}

function minimalPaths(paths: readonly string[]): readonly string[] {
  const ordered = [...new Set(paths)].sort((left, right) => left.split("/").length - right.split("/").length);
  return ordered.filter((path, index) => !ordered.slice(0, index).some((parent) => path.startsWith(`${parent}/`)));
}

function createdParents(paths: readonly string[], baseline: SourceTree): readonly string[] {
  const parents = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const parent = segments.slice(0, index).join("/");
      if (!baseline.has(parent)) parents.add(parent);
    }
  }
  return [...parents].sort((left, right) => right.split("/").length - left.split("/").length);
}

function isMissingOrNotEmpty(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTEMPTY" || error.code === "EEXIST";
}

function copyOptions(): Readonly<{
  recursive: true;
  preserveTimestamps: true;
  verbatimSymlinks: true;
}> {
  return { recursive: true, preserveTimestamps: true, verbatimSymlinks: true };
}

async function captureTree(root: string): Promise<SourceTree> {
  const entries = new Map<string, SourceEntry>();
  await visit(root, "", entries);
  return entries;
}

async function visit(root: string, path: string, entries: Map<string, SourceEntry>): Promise<void> {
  const absolute = path.length === 0 ? root : join(root, path);
  const children = await readdir(absolute, { withFileTypes: true });
  await Promise.all(children.map(async (child) => {
    const childPath = path.length === 0 ? child.name : `${path}/${child.name}`;
    const identity = await sourceEntry(root, childPath);
    entries.set(childPath, identity);
    if (identity.kind === "directory") await visit(root, childPath, entries);
  }));
}

async function sourceEntry(root: string, path: string): Promise<SourceEntry> {
  const absolute = join(root, path);
  const info = await lstat(absolute);
  const kind = info.isDirectory()
    ? "directory"
    : info.isFile()
      ? "file"
      : info.isSymbolicLink()
        ? "symlink"
        : "special";
  const content = kind === "file"
    ? await readFile(absolute)
    : kind === "symlink"
      ? Buffer.from(await readlink(absolute))
      : Buffer.from(kind);
  return { kind, mode: info.mode, digest: createHash("sha256").update(content).digest("hex") };
}

async function optionalSourceEntry(root: string, path: string): Promise<SourceEntry | undefined> {
  try {
    return await sourceEntry(root, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function changedPaths(before: SourceTree, after: SourceTree): readonly string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => !sameEntry(before.get(path), after.get(path))).sort();
}

function sameEntry(left: SourceEntry | undefined, right: SourceEntry | undefined): boolean {
  return left?.kind === right?.kind && left?.mode === right?.mode && left?.digest === right?.digest;
}

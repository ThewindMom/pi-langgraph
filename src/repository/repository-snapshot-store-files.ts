import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  digest,
  repositoryPath,
  type SnapshotEntry,
} from "./repository-snapshot-store-codec.ts";
import {
  RepositorySnapshotStoreError,
  type RepositorySnapshotStoreErrorCode,
} from "./repository-snapshot-store-types.ts";

export async function readRegularFile(
  path: string,
  maximum: number,
  code: RepositorySnapshotStoreErrorCode,
): Promise<Buffer> {
  const pathInfo = await lstat(path);
  if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
    throw new RepositorySnapshotStoreError(code, `unsafe snapshot file: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (before.dev !== pathInfo.dev || before.ino !== pathInfo.ino || before.size > maximum) {
      throw new RepositorySnapshotStoreError(code, `unsafe or oversized snapshot file: ${path}`);
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || content.length !== after.size) {
      throw new RepositorySnapshotStoreError(code, `snapshot file changed while reading: ${path}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

export async function writeAddressed(destination: string, content: Buffer): Promise<void> {
  try {
    const existing = await readRegularFile(destination, content.length, "corrupt-snapshot");
    if (existing.equals(content)) return;
    throw new RepositorySnapshotStoreError("corrupt-snapshot", `content-addressed snapshot collision: ${destination}`);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = join(dirname(destination), `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function collectDestinationEntries(root: string, path = ""): Promise<readonly SnapshotEntry[]> {
  const entries: SnapshotEntry[] = [];
  for (const child of await readdir(path.length === 0 ? root : join(root, path), { withFileTypes: true })) {
    if (path.length === 0 && child.name === ".git") continue;
    const childPath = path.length === 0 ? child.name : `${path}/${child.name}`;
    if (child.isDirectory()) entries.push(...await collectDestinationEntries(root, childPath));
    else {
      const absolute = join(root, childPath);
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new RepositorySnapshotStoreError("unsafe-destination", `materialized tree contains unsafe entry: ${childPath}`);
      }
      const content = await readRegularFile(absolute, info.size, "unsafe-destination");
      entries.push({ path: childPath, blobId: digest(content), executable: (info.mode & 0o111) !== 0, size: content.length });
    }
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export async function realDirectory(path: string, code: RepositorySnapshotStoreErrorCode): Promise<string> {
  const resolved = await realpath(resolve(path));
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new RepositorySnapshotStoreError(code, `path must be a real directory: ${path}`);
  }
  return resolved;
}

export async function removeExistingFile(root: string, path: string): Promise<void> {
  const absolute = join(root, repositoryPath(path));
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RepositorySnapshotStoreError("unsafe-destination", `refusing unsafe deletion target: ${path}`);
    }
    await rm(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

export async function writeDestinationFile(root: string, entry: SnapshotEntry, content: Buffer): Promise<void> {
  const absolute = join(root, entry.path);
  await safeParents(root, dirname(entry.path));
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RepositorySnapshotStoreError("unsafe-destination", `refusing unsafe materialization target: ${entry.path}`);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temporary = `${absolute}.pi-langgraph-${randomUUID()}`;
  const handle = await open(temporary, "wx", entry.executable ? 0o700 : 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, absolute);
    await chmod(absolute, entry.executable ? 0o755 : 0o644);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function safeParents(root: string, path: string): Promise<void> {
  if (path === ".") return;
  let current = root;
  for (const segment of path.split("/")) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new RepositorySnapshotStoreError("unsafe-destination", `unsafe materialization parent: ${path}`);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

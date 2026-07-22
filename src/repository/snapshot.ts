import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  getRepositoryHead,
  getRepositoryPaths,
  getRepositoryRoot,
  getRepositoryStatus,
  getTrackedDiff,
  getUntrackedPaths,
} from "./git.ts";

export const SNAPSHOT_PROTOCOL_VERSION = 1;
export type RepositorySnapshot = Readonly<{
  snapshotId: string;
  repositoryRoot: string;
  head: string | null;
  dirty: boolean;
  protocolVersion: number;
}>;

const MANIFEST_NAMES = new Set([
  "package.json", "bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "tsconfig.json", "tsconfig.base.json", "deno.json", "deno.jsonc", "Cargo.toml", "Cargo.lock", "go.mod", "go.sum",
  "pyproject.toml", "poetry.lock", "Pipfile", "Pipfile.lock", "requirements.txt", "Gemfile", "Gemfile.lock",
]);
const MAX_BYTES = 8 * 1024 * 1024;

export async function createRepositorySnapshot(cwd: string): Promise<RepositorySnapshot> {
  const repositoryRoot = await getRepositoryRoot(cwd);
  const head = getRepositoryHead(repositoryRoot);
  const status = getRepositoryStatus(repositoryRoot);
  const paths = getRepositoryPaths(repositoryRoot);
  const untracked = await collectEntries(repositoryRoot, getUntrackedPaths(repositoryRoot));
  const manifests = await collectManifests(repositoryRoot, paths);
  const payload = [
    `protocolVersion:${SNAPSHOT_PROTOCOL_VERSION}`,
    `repositoryRoot:${repositoryRoot}`,
    `head:${head ?? ""}`,
    `dirty:${status.length > 0 ? "1" : "0"}`,
    `status:${status}`,
    `trackedDiff:${getTrackedDiff(repositoryRoot)}`,
    `untracked:${untracked}`,
    `manifests:${manifests}`,
  ].join("\n\0");
  const snapshotId = createHash("sha256").update(payload).digest("hex");
  return { snapshotId, repositoryRoot, head, dirty: status.length > 0, protocolVersion: SNAPSHOT_PROTOCOL_VERSION };
}

async function collectManifests(root: string, paths: readonly string[]): Promise<string> {
  const entries: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    if (!MANIFEST_NAMES.has(path.split("/").pop() ?? "")) continue;
    const absolute = safePath(root, path);
    const encoded = await readSnapshotEntry(root, absolute, path, MAX_BYTES - bytes);
    if (encoded === null) break;
    entries.push(encoded);
    bytes += encoded.length;
  }
  return entries.sort().join("\n");
}

async function collectEntries(root: string, paths: readonly string[]): Promise<string> {
  const entries: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const encoded = await readSnapshotEntry(root, safePath(root, path), path, MAX_BYTES - bytes);
    if (encoded === null) break;
    entries.push(encoded);
    bytes += encoded.length;
  }
  return entries.sort().join("\n");
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Git returned an absolute path: ${path}`);
  const absolute = resolve(root, path);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) throw new Error(`Path escapes repository: ${path}`);
  return absolute;
}

async function readSnapshotEntry(root: string, absolute: string, path: string, budget: number): Promise<string | null> {
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error(`Refusing symlink snapshot entry: ${path}`);
  if (!info.isFile()) return JSON.stringify({ path, type: "special" });
  const resolved = await realpath(absolute);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error(`Path escapes repository: ${path}`);
  const maxRawBytes = Math.max(0, Math.floor((budget - 128) * 3 / 4));
  if (info.size > maxRawBytes) return null;
  const handle = await open(absolute, "r");
  const content = Buffer.alloc(info.size);
  await handle.read(content, 0, info.size, 0);
  await handle.close();
  return JSON.stringify({ path, type: "file", content: content.toString("base64") });
}

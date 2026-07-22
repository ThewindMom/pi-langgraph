import { chmod, lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArtifactRef } from "./artifact-format.ts";
import { isDigest } from "./artifact-format.ts";
import type { ArtifactStore } from "./artifact-store.ts";
import { withCheckpointFileLock } from "./file-lock.ts";

const MANIFEST = "retention.json";
const MAX_BYTES = 1 * 1024 * 1024;
const ID = /^[A-Za-z0-9._~-]{1,128}$/;
const KINDS = ["thread", "checkpoint", "interrupt", "mutation", "fork"] as const;
const REPOSITORY_LOCK = "repository-services";
export type RetentionKind = (typeof KINDS)[number];
export type RetentionOwner = { readonly kind: RetentionKind; readonly id: string };
type Entry = { readonly owner: RetentionOwner; readonly refs: readonly ArtifactRef[] };
type Manifest = { readonly entries: readonly Entry[]; readonly released: readonly string[] };

function ownerText(owner: RetentionOwner): string {
  if (!KINDS.includes(owner.kind) || !ID.test(owner.id)) throw new Error("invalid retention owner");
  return `${owner.kind}:${owner.id}`;
}
function checkRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  if (refs.length > 4096) throw new Error("too many artifact references");
  return refs.map((ref) => {
    if (!isDigest(ref.digest) || !Number.isSafeInteger(ref.byteCount) || ref.byteCount < 0 || typeof ref.truncated !== "boolean") throw new Error("invalid artifact reference");
    return { digest: ref.digest, byteCount: ref.byteCount, truncated: ref.truncated };
  });
}
function parse(data: Uint8Array): Manifest {
  if (data.byteLength > MAX_BYTES) throw new Error("retention manifest exceeds size limit");
  const value: unknown = JSON.parse(new TextDecoder().decode(data));
  if (typeof value !== "object" || value === null || !("entries" in value) || !("released" in value)) throw new Error("invalid retention manifest");
  const raw = value as { entries?: unknown; released?: unknown };
  if (!Array.isArray(raw.entries) || !Array.isArray(raw.released) || raw.entries.length > 4096 || raw.released.length > 4096) throw new Error("invalid retention manifest");
  const entries = raw.entries.map((item): Entry => {
    if (typeof item !== "object" || item === null || !("owner" in item) || !("refs" in item)) throw new Error("invalid retention entry");
    const row = item as { owner?: unknown; refs?: unknown };
    if (typeof row.owner !== "object" || row.owner === null || !("kind" in row.owner) || !("id" in row.owner) || !Array.isArray(row.refs)) throw new Error("invalid retention entry");
    const owner = row.owner as { kind?: unknown; id?: unknown };
    if (typeof owner.kind !== "string" || typeof owner.id !== "string") throw new Error("invalid retention owner");
    const typedOwner = { kind: owner.kind as RetentionKind, id: owner.id };
    ownerText(typedOwner);
    return { owner: typedOwner, refs: checkRefs(row.refs as readonly ArtifactRef[]) };
  });
  const released = raw.released.map((item) => {
    if (typeof item !== "string") throw new Error("invalid released owner");
    const [kind, id] = item.split(":");
    if (!KINDS.includes(kind as RetentionKind) || id === undefined || !ID.test(id)) throw new Error("invalid released owner");
    return item;
  });
  return { entries, released };
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, "r"); try { await handle.sync(); } finally { await handle.close(); } }

export class RetentionIndex {
  private constructor(private readonly root: string, private manifest: Manifest) {}
  static async open(root: string): Promise<RetentionIndex> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(absolute);
    if (!rootInfo.isDirectory()) throw new Error("retention root is not a directory");
    await chmod(absolute, 0o700);
    const path = join(absolute, MANIFEST);
    try { const info = await lstat(path); if (!info.isFile()) throw new Error("retention manifest is not a regular file"); return new RetentionIndex(absolute, parse(await readFile(path))); }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return new RetentionIndex(absolute, { entries: [], released: [] }); throw error; }
  }
  async pin(owner: RetentionOwner, refs: readonly ArtifactRef[]): Promise<void> { return this.update(owner, refs); }
  async update(owner: RetentionOwner, refs: readonly ArtifactRef[]): Promise<void> {
    return this.reconcile([{ owner, refs }], []);
  }
  async release(owner: RetentionOwner): Promise<void> {
    return this.reconcile([], [owner]);
  }
  async reconcile(updates: readonly Entry[], releases: readonly RetentionOwner[]): Promise<void> {
    return withCheckpointFileLock(dirname(this.root), REPOSITORY_LOCK, async () => {
      await this.reload();
      const released = new Set(releases.map(ownerText));
      const changed = new Set(updates.map((entry) => ownerText(entry.owner)));
      const entries = this.manifest.entries.filter((entry) => {
        const key = ownerText(entry.owner);
        return !released.has(key) && !changed.has(key);
      });
      this.manifest = {
        entries: [...entries, ...updates.map((entry) => ({ owner: entry.owner, refs: checkRefs(entry.refs) }))],
        released: [],
      };
      await this.persist();
    });
  }
  reachable(): ReadonlySet<string> { return new Set(this.manifest.entries.flatMap((entry) => entry.refs.map((ref) => ref.digest))); }
  async compact(artifactStore: ArtifactStore): Promise<{ readonly removed: readonly string[] }> {
    return artifactStore.compact(this.root);
  }
  private async reload(): Promise<void> {
    this.manifest = await readManifest(this.root);
  }
  private async persist(): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(this.manifest)); if (bytes.byteLength > MAX_BYTES) throw new Error("retention manifest exceeds size limit");
    const path = join(this.root, MANIFEST); if (dirname(path) !== this.root) throw new Error("invalid retention path");
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`; const handle = await open(temp, "wx", 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path); await chmod(path, 0o600); await syncDirectory(this.root);
  }
}

async function readManifest(root: string): Promise<Manifest> {
  try {
    const path = join(root, MANIFEST);
    const info = await lstat(path);
    if (!info.isFile()) throw new Error("retention manifest is not a regular file");
    return parse(await readFile(path));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { entries: [], released: [] };
    }
    throw error;
  }
}

export async function readRetentionReachable(root: string): Promise<ReadonlySet<string>> {
  const manifest = await readManifest(root);
  return new Set(manifest.entries.flatMap((entry) => entry.refs.map((ref) => ref.digest)));
}

export { RetentionIndex as RetentionManager, ownerText };

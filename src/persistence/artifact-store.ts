import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ArtifactManifest, ArtifactRef } from "./artifact-format.ts";
import { isDigest, MAX_CONTENT_BYTES, parseManifest, serializeManifest } from "./artifact-format.ts";
import { withCheckpointFileLock } from "./file-lock.ts";
import { readRetentionReachable } from "./reachability.ts";

const MANIFEST_NAME = "manifest.json";
const REPOSITORY_LOCK = "repository-services";

function hasCode(error: unknown): error is { readonly code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function bytesFor(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export class ArtifactStore {
  private constructor(private readonly root: string, private readonly blobs: string, private manifest: ArtifactManifest) {}

  static async open(root: string): Promise<ArtifactStore> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await chmod(absolute, 0o700);
    const blobs = join(absolute, "blobs");
    await mkdir(blobs, { recursive: true, mode: 0o700 });
    await chmod(blobs, 0o700);
    let manifest: ArtifactManifest = { owners: {} };
    try {
      const manifestPath = join(absolute, MANIFEST_NAME);
      const info = await lstat(manifestPath);
      if (!info.isFile()) throw new Error("artifact manifest is not a regular file");
      manifest = parseManifest(await readFile(manifestPath));
    } catch (error) {
      if (!hasCode(error) || error.code !== "ENOENT") throw error;
    }
    return new ArtifactStore(absolute, blobs, manifest);
  }

  async put(content: string | Uint8Array): Promise<ArtifactRef> {
    return this.withLock(() => this.putUnlocked(content));
  }

  async putOwned(owner: string, content: string | Uint8Array): Promise<ArtifactRef> {
    return this.withLock(async () => {
      const ref = await this.putUnlocked(content);
      this.validateOwner(owner);
      const current = this.manifest.owners[owner] ?? [];
      const owners = { ...this.manifest.owners, [owner]: [...new Set([...current, ref.digest])] };
      this.manifest = { owners };
      await this.persistManifest();
      return ref;
    });
  }

  private async putUnlocked(content: string | Uint8Array): Promise<ArtifactRef> {
    const bytes = bytesFor(content);
    if (bytes.byteLength > MAX_CONTENT_BYTES) throw new Error("artifact content exceeds size limit");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const target = this.blobPath(digest);
    try {
      const info = await lstat(target);
      if (!info.isFile()) throw new Error("artifact path is not a file");
      return { digest, byteCount: bytes.byteLength, truncated: false };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    const temp = join(this.blobs, `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    try { await rename(temp, target); } catch (error) {
      if (!hasCode(error) || !(["EEXIST", "ENOTEMPTY"].includes(error.code))) throw error;
      await rm(temp, { force: true });
    }
    await chmod(target, 0o600);
    await syncDirectory(this.blobs);
    return { digest, byteCount: bytes.byteLength, truncated: false };
  }

  async get(ref: ArtifactRef): Promise<Uint8Array> {
    if (!isDigest(ref.digest)) throw new Error("invalid artifact digest");
    let data: Uint8Array;
    try {
      const info = await lstat(this.blobPath(ref.digest));
      if (!info.isFile()) throw new Error("artifact is not a regular file");
      data = await readFile(this.blobPath(ref.digest));
    } catch (error) {
      if (hasCode(error) && error.code === "ENOENT") throw new Error("artifact not found", { cause: error });
      throw error;
    }
    if (data.byteLength > MAX_CONTENT_BYTES) throw new Error("artifact content exceeds size limit");
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== ref.digest) throw new Error("artifact digest mismatch");
    return new Uint8Array(data);
  }

  async pin(owner: string, refs: readonly ArtifactRef[]): Promise<void> {
    return this.withLock(async () => {
      this.validateOwner(owner);
      const digests = refs.map((ref) => {
        if (!isDigest(ref.digest)) throw new Error("invalid artifact digest");
        return ref.digest;
      });
      const owners: Record<string, readonly string[]> = { ...this.manifest.owners, [owner]: digests };
      this.manifest = { owners };
      await this.persistManifest();
    });
  }

  async unpin(owner: string): Promise<void> {
    return this.withLock(async () => {
      const owners: Record<string, readonly string[]> = { ...this.manifest.owners };
      delete owners[owner];
      this.manifest = { owners };
      await this.persistManifest();
    });
  }

  async compact(retentionRoot?: string): Promise<{ readonly removed: readonly string[] }> {
    return this.withLock(async () => {
      const reachable = new Set(Object.values(this.manifest.owners).flat());
      if (retentionRoot !== undefined) {
        for (const digest of await readRetentionReachable(retentionRoot)) reachable.add(digest);
      }
      const removed: string[] = [];
      for (const entry of await readdir(this.blobs, { withFileTypes: true })) {
        if (!entry.isFile() || !isDigest(entry.name) || reachable.has(entry.name)) continue;
        await rm(join(this.blobs, entry.name), { force: true });
        removed.push(entry.name);
      }
      if (removed.length > 0) await syncDirectory(this.blobs);
      removed.sort();
      return { removed };
    });
  }

  private validateOwner(owner: string): void {
    if (owner.length === 0 || owner.length > 256) throw new Error("invalid artifact owner");
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withCheckpointFileLock(dirname(this.root), REPOSITORY_LOCK, async () => {
      await this.reloadManifest();
      return operation();
    });
  }

  private async reloadManifest(): Promise<void> {
    try {
      const path = join(this.root, MANIFEST_NAME);
      const info = await lstat(path);
      if (!info.isFile()) throw new Error("artifact manifest is not a regular file");
      this.manifest = parseManifest(await readFile(path));
    } catch (error) {
      if (!hasCode(error) || error.code !== "ENOENT") throw error;
      this.manifest = { owners: {} };
    }
  }

  private blobPath(digest: string): string {
    if (!isDigest(digest)) throw new Error("invalid artifact digest");
    const path = resolve(this.blobs, digest);
    if (dirname(path) !== this.blobs) throw new Error("invalid artifact path");
    return path;
  }

  private async persistManifest(): Promise<void> {
    const bytes = serializeManifest(this.manifest);
    const path = join(this.root, MANIFEST_NAME);
    const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, path);
    await chmod(path, 0o600);
    await syncDirectory(this.root);
  }
}

export type { ArtifactRef } from "./artifact-format.ts";

import { chmod, lstat, mkdir, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { getRepositoryHead, getRepositoryPaths, getRepositoryRoot, getRepositoryStatus, runGit } from "./git.ts";
import {
  digest,
  DIGEST_PATTERN,
  parseEnvelope,
  repositoryPath,
  sameEntries,
  sameStrings,
  type SnapshotEntry,
  type SnapshotManifest,
} from "./repository-snapshot-store-codec.ts";
import {
  collectDestinationEntries,
  isMissing,
  readRegularFile,
  realDirectory,
  removeExistingFile,
  writeAddressed,
  writeDestinationFile,
} from "./repository-snapshot-store-files.ts";
import {
  RepositorySnapshotStoreError,
  type RepositorySnapshotTarget,
  type StoredRepositorySnapshot,
} from "./repository-snapshot-store-types.ts";
import { createRepositorySnapshot, SNAPSHOT_PROTOCOL_VERSION } from "./snapshot.ts";

export {
  RepositorySnapshotStoreError,
  type RepositorySnapshotStoreErrorCode,
  type RepositorySnapshotTarget,
  type StoredRepositorySnapshot,
} from "./repository-snapshot-store-types.ts";

const STORE_DIRECTORY = "repository-snapshots";
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

export class RepositorySnapshotStore {
  private constructor(
    private readonly manifests: string,
    private readonly blobs: string,
  ) {}

  static async open(extensionDataRoot: string): Promise<RepositorySnapshotStore> {
    const dataRoot = resolve(extensionDataRoot);
    const root = join(dataRoot, STORE_DIRECTORY);
    const manifests = join(root, "manifests");
    const blobs = join(root, "blobs");
    for (const path of [dataRoot, root, manifests, blobs]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new RepositorySnapshotStoreError("unsafe-store", `snapshot store path must be a real directory: ${path}`);
      }
      await chmod(path, 0o700);
    }
    return new RepositorySnapshotStore(manifests, blobs);
  }

  async capture(cwd: string): Promise<StoredRepositorySnapshot> {
    const initial = await createRepositorySnapshot(cwd);
    const root = await getRepositoryRoot(cwd);
    const tracked = gitPaths(root);
    const paths = getRepositoryPaths(root);
    const captured = await this.captureEntries(root, paths, new Set(tracked), true);
    const final = await createRepositorySnapshot(root);
    const finalTracked = gitPaths(root);
    const finalPaths = getRepositoryPaths(root);
    const verified = await this.captureEntries(root, finalPaths, new Set(finalTracked), false);
    if (
      initial.snapshotId !== final.snapshotId
      || initial.head !== final.head
      || initial.dirty !== final.dirty
      || !sameStrings(tracked, finalTracked)
      || !sameStrings(paths, finalPaths)
      || !sameEntries(captured.entries, verified.entries)
      || !sameStrings(captured.deletedPaths, verified.deletedPaths)
    ) {
      throw new RepositorySnapshotStoreError("source-changed", "source repository changed while its snapshot was captured");
    }
    const manifest: SnapshotManifest = {
      protocolVersion: SNAPSHOT_PROTOCOL_VERSION,
      snapshotId: initial.snapshotId,
      baselineHead: initial.head,
      dirty: initial.dirty,
      entries: captured.entries,
      deletedPaths: captured.deletedPaths,
    };
    const encodedManifest = JSON.stringify(manifest);
    const envelope = `${JSON.stringify({ manifest, digest: digest(Buffer.from(encodedManifest)) })}\n`;
    await writeAddressed(join(this.manifests, `${manifest.snapshotId}.json`), Buffer.from(envelope));
    return {
      protocolVersion: manifest.protocolVersion,
      snapshotId: manifest.snapshotId,
      baselineHead: manifest.baselineHead,
      dirty: manifest.dirty,
    };
  }

  async materialize(snapshotId: string, target: RepositorySnapshotTarget): Promise<void> {
    const manifest = await this.readManifest(snapshotId);
    const destination = await this.validateTarget(target, manifest);
    const contents = new Map<string, Buffer>();
    let totalBytes = 0;
    for (const entry of manifest.entries) {
      totalBytes += entry.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) {
        throw new RepositorySnapshotStoreError("corrupt-snapshot", "snapshot exceeds the materialization byte limit");
      }
      const content = await readRegularFile(join(this.blobs, entry.blobId), entry.size, "corrupt-snapshot");
      if (digest(content) !== entry.blobId) {
        throw new RepositorySnapshotStoreError("corrupt-snapshot", `snapshot blob is corrupt: ${entry.blobId}`);
      }
      contents.set(entry.blobId, content);
    }
    for (const path of manifest.deletedPaths) await removeExistingFile(destination, path);
    for (const entry of manifest.entries) {
      const content = contents.get(entry.blobId);
      if (content === undefined) throw new RepositorySnapshotStoreError("corrupt-snapshot", "snapshot blob was not loaded");
      await writeDestinationFile(destination, entry, content);
    }
    if (!await this.verifyMaterialized(snapshotId, destination)) {
      throw new RepositorySnapshotStoreError("corrupt-snapshot", "materialized tree does not match its snapshot");
    }
  }

  async has(snapshotId: string): Promise<boolean> {
    if (!DIGEST_PATTERN.test(snapshotId)) {
      throw new RepositorySnapshotStoreError("snapshot-missing", `invalid repository snapshot id: ${snapshotId}`);
    }
    try {
      await this.readManifest(snapshotId);
      return true;
    } catch (error) {
      if (error instanceof RepositorySnapshotStoreError && error.code === "snapshot-missing") return false;
      throw error;
    }
  }

  async verifyMaterialized(snapshotId: string, destination: string): Promise<boolean> {
    const manifest = await this.readManifest(snapshotId);
    const actual = await collectDestinationEntries(await realDirectory(destination, "unsafe-destination"));
    return sameEntries(manifest.entries, actual);
  }

  private async captureEntries(
    root: string,
    paths: readonly string[],
    tracked: ReadonlySet<string>,
    persist: boolean,
  ): Promise<Readonly<{ entries: readonly SnapshotEntry[]; deletedPaths: readonly string[] }>> {
    const entries: SnapshotEntry[] = [];
    const deletedPaths: string[] = [];
    for (const rawPath of paths) {
      const path = repositoryPath(rawPath);
      const absolute = join(root, path);
      let info;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if (isMissing(error) && tracked.has(path)) {
          deletedPaths.push(path);
          continue;
        }
        if (isMissing(error)) throw new RepositorySnapshotStoreError("source-changed", `repository entry disappeared: ${path}`);
        throw error;
      }
      if (info.isSymbolicLink()) throw new RepositorySnapshotStoreError("unsafe-entry", `refusing symlink snapshot entry: ${path}`);
      if (!info.isFile()) throw new RepositorySnapshotStoreError("unsafe-entry", `refusing special snapshot entry: ${path}`);
      const content = await readRegularFile(absolute, info.size, "source-changed");
      const blobId = digest(content);
      if (persist) await writeAddressed(join(this.blobs, blobId), content);
      entries.push({ path, blobId, executable: (info.mode & 0o111) !== 0, size: content.length });
    }
    return { entries, deletedPaths };
  }

  private async readManifest(snapshotId: string): Promise<SnapshotManifest> {
    if (!DIGEST_PATTERN.test(snapshotId)) {
      throw new RepositorySnapshotStoreError("snapshot-missing", `invalid repository snapshot id: ${snapshotId}`);
    }
    let raw: Buffer;
    try {
      raw = await readRegularFile(join(this.manifests, `${snapshotId}.json`), MAX_MANIFEST_BYTES, "corrupt-snapshot");
    } catch (error) {
      if (isMissing(error)) throw new RepositorySnapshotStoreError("snapshot-missing", `repository snapshot not found: ${snapshotId}`);
      throw error;
    }
    return parseEnvelope(raw, snapshotId).manifest;
  }

  private async validateTarget(target: RepositorySnapshotTarget, manifest: SnapshotManifest): Promise<string> {
    const managerRoot = await realDirectory(target.managerRoot, "unsafe-destination");
    const destination = await realDirectory(target.destination, "unsafe-destination");
    const ownedPath = relative(managerRoot, destination);
    if (ownedPath.length === 0 || ownedPath === ".." || ownedPath.startsWith("../") || isAbsolute(ownedPath)) {
      throw new RepositorySnapshotStoreError("unsafe-destination", "snapshot destination is outside its manager-owned root");
    }
    if (target.kind === "empty-directory") {
      if ((await readdir(destination)).length > 0) {
        throw new RepositorySnapshotStoreError("destination-not-empty", "snapshot destination must be empty");
      }
      return destination;
    }
    const repositoryRoot = await getRepositoryRoot(destination);
    if (
      repositoryRoot !== destination
      || getRepositoryHead(destination) !== manifest.baselineHead
      || getRepositoryStatus(destination).length > 0
    ) {
      throw new RepositorySnapshotStoreError("unsafe-destination", "managed worktree must be clean at the snapshot baseline");
    }
    return destination;
  }
}

function gitPaths(root: string): readonly string[] {
  const result = runGit(root, ["ls-files", "--cached", "-z"]);
  if (result.exitCode !== 0) throw new RepositorySnapshotStoreError("source-changed", "unable to inspect repository paths");
  return result.stdout.split("\0").filter((path) => path.length > 0).sort();
}

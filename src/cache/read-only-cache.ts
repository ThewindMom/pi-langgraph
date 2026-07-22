import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { resolve, join } from "node:path";

export const READ_ONLY_OPERATIONS = ["discovery", "specialist"] as const;
export type ReadOnlyOperation = (typeof READ_ONLY_OPERATIONS)[number];
export type CacheOperation = ReadOnlyOperation | string;
export type ReadOnlyCacheKey = {
  readonly snapshotId: string;
  readonly operation: CacheOperation;
  readonly inputHash: string;
  readonly policyHash: string;
};
export type CacheArtifactRef = {
  readonly digest: string;
  readonly byteCount: number;
  readonly truncated?: boolean;
};
export type CacheMetadata = Readonly<Record<string, string>>;

type StoredEntry = {
  readonly key: ReadOnlyCacheKey;
  readonly artifact: CacheArtifactRef;
  readonly metadata?: CacheMetadata;
};
type CacheFile = { readonly version: 1; readonly entries: Readonly<Record<string, StoredEntry>> };

const FILE_NAME = "cache.json";
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReadOnlyOperation(operation: CacheOperation): operation is ReadOnlyOperation {
  return operation === "discovery" || operation === "specialist";
}
function keyText(key: ReadOnlyCacheKey): string {
  return JSON.stringify([key.snapshotId, key.operation, key.inputHash, key.policyHash]);
}
function keyHash(key: ReadOnlyCacheKey): string {
  return createHash("sha256").update(keyText(key)).digest("hex");
}
function validateKey(key: ReadOnlyCacheKey): void {
  if (!isReadOnlyOperation(key.operation)) throw new Error("read-only cache rejects non-read-only operation");
  if ([key.snapshotId, key.inputHash, key.policyHash].some((part) => part.length === 0 || part.length > 4096)) throw new Error("invalid read-only cache key");
}
function parseEntry(value: unknown): value is StoredEntry {
  if (!isObject(value) || !isObject(value.key) || !isObject(value.artifact)) return false;
  const key = value.key;
  const artifact = value.artifact;
  return typeof key.snapshotId === "string" && typeof key.operation === "string" && isReadOnlyOperation(key.operation)
    && typeof key.inputHash === "string" && typeof key.policyHash === "string"
    && typeof artifact.digest === "string" && DIGEST.test(artifact.digest)
    && typeof artifact.byteCount === "number" && Number.isSafeInteger(artifact.byteCount) && artifact.byteCount >= 0
    && (artifact.truncated === undefined || typeof artifact.truncated === "boolean");
}
function parseFile(data: Uint8Array): CacheFile {
  if (data.byteLength > MAX_FILE_BYTES) throw new Error("read-only cache exceeds size limit");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.entries)) throw new Error("invalid read-only cache");
  const entries: Record<string, StoredEntry> = {};
  for (const [hash, value] of Object.entries(parsed.entries)) {
    if (!DIGEST.test(hash) || !parseEntry(value)) throw new Error("invalid read-only cache entry");
    entries[hash] = value;
  }
  return { version: 1, entries };
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

export class ReadOnlyCache {
  private constructor(private readonly root: string, private readonly file: string, private entries: Record<string, StoredEntry>) {}

  static async open(root: string): Promise<ReadOnlyCache> {
    const absolute = resolve(root);
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    await chmod(absolute, 0o700);
    const file = join(absolute, FILE_NAME);
    let entries: Record<string, StoredEntry> = {};
    try { entries = parseFile(await readFile(file)).entries; }
    catch (error) {
      if (!(isObject(error) && error.code === "ENOENT")) throw error;
    }
    return new ReadOnlyCache(absolute, file, entries);
  }

  async get(key: ReadOnlyCacheKey): Promise<CacheArtifactRef | undefined> {
    validateKey(key);
    const entry = this.entries[keyHash(key)];
    return entry !== undefined && keyText(entry.key) === keyText(key) ? entry.artifact : undefined;
  }

  async set(key: ReadOnlyCacheKey, artifact: CacheArtifactRef, metadata?: CacheMetadata): Promise<void> {
    validateKey(key);
    if (!DIGEST.test(artifact.digest) || !Number.isSafeInteger(artifact.byteCount) || artifact.byteCount < 0) throw new Error("invalid artifact reference");
    const hash = keyHash(key);
    const entry: StoredEntry = metadata === undefined ? { key, artifact } : { key, artifact, metadata };
    const entries = { ...this.entries, [hash]: entry };
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, entries } satisfies CacheFile));
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("read-only cache exceeds size limit");
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, this.file); await chmod(this.file, 0o600); await syncDirectory(this.root); this.entries = entries; }
    catch (error) { await rm(temp, { force: true }); throw error; }
  }
}

import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepositorySnapshot } from "../repository/snapshot.ts";
import {
  MEMORY_FILE_VERSION, type MemoryProvenance,
  parseMemory, serializeMemory, validateMemoryKey, validateSnapshotId,
} from "./format.ts";

export type { MemoryProvenance } from "./format.ts";

type StoredFact = Readonly<{ readonly value: unknown; readonly provenance: MemoryProvenance }>;

export class RepositoryMemory {
  private constructor(private readonly root: string, private entries: Record<string, Record<string, unknown>>) {}

  static async open(root: string): Promise<RepositoryMemory> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const path = join(root, "memory.json");
    try {
      const raw = await readFile(path, "utf8");
      return new RepositoryMemory(root, { ...parseMemory(raw, path).entries });
    } catch (error) {
      if (isMissingFile(error)) return new RepositoryMemory(root, Object.create(null));
      throw error;
    }
  }

  async put<T>(snapshot: RepositorySnapshot | string, key: string, value: T, provenance?: MemoryProvenance): Promise<void> {
    const snapshotId = snapshotIdOf(snapshot);
    validateMemoryKey(key);
    const fact = provenance === undefined ? value : { value, provenance };
    validateFact(fact);
    const bucket = this.entries[snapshotId] ?? Object.create(null);
    this.entries = { ...this.entries, [snapshotId]: { ...bucket, [key]: fact } };
    await this.persist();
  }

  async get(snapshot: RepositorySnapshot | string, key: string): Promise<unknown | undefined> {
    const snapshotId = snapshotIdOf(snapshot);
    validateMemoryKey(key);
    const bucket = this.entries[snapshotId];
    return bucket?.[key];
  }

  private async persist(): Promise<void> {
    const path = join(this.root, "memory.json");
    const raw = serializeMemory({ version: MEMORY_FILE_VERSION, entries: this.entries });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, raw, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    try { await rename(temp, path); } catch (error) { await unlink(temp).catch(() => undefined); throw error; }
    await chmod(path, 0o600);
  }
}

function snapshotIdOf(snapshot: RepositorySnapshot | string): string {
  const id = typeof snapshot === "string" ? snapshot : snapshot.snapshotId;
  validateSnapshotId(id);
  return id;
}

function validateFact(value: unknown): asserts value is StoredFact {
  if (!isRecord(value) || !isRecord(value.provenance) || !isValidProvenance(value.provenance)) throw new Error("repository memory facts require valid provenance");
}

function isValidProvenance(value: Record<string, unknown>): value is MemoryProvenance {
  return typeof value.sourceCheckpointId === "string" && value.sourceCheckpointId.length > 0 && value.sourceCheckpointId.length <= 256
    && Array.isArray(value.artifactRefs) && value.artifactRefs.every(isArtifactRef)
    && typeof value.observedAt === "string" && !Number.isNaN(Date.parse(value.observedAt))
    && typeof value.schemaVersion === "number" && Number.isInteger(value.schemaVersion) && value.schemaVersion >= 1
    && typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1;
}

function isArtifactRef(value: unknown): value is { readonly digest: string; readonly byteCount: number; readonly truncated: boolean } {
  return isRecord(value) && typeof value.digest === "string" && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.byteCount === "number" && Number.isInteger(value.byteCount) && value.byteCount >= 0
    && typeof value.truncated === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

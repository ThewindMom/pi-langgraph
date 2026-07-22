import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  MemorySaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { validateEffectiveWorkflowState, type PersistedWorkflowWrite } from "./workflow-pending-write-validation.ts";
import {
  FILE_SUFFIX,
  FILE_VERSION,
  type SerializedCheckpointEntry,
  type SerializedThread,
  type SerializedWriteEntry,
  decode,
  encode,
  fileNameForThread,
  parseSerializedThread,
  parseWriteBucketKey,
  validateThreadId,
} from "./file-checkpoint-format.ts";
import { validateCheckpoint, validateCheckpointMetadata } from "./file-checkpoint-validation.ts";
import { atomicWrite, isNodeErrorCode, readBoundedFile } from "./checkpoint-file-io.ts";

export class FileCheckpointSaver extends BaseCheckpointSaver {
  readonly rootDirectory: string;
  readonly memory: MemorySaver;
  readonly quarantinedFiles: Array<{ readonly fileName: string; readonly error: string }> = [];
  private readonly corruptFiles = new Map<string, { readonly quarantineName: string; readonly error: string }>();
  private pending: Promise<void> = Promise.resolve();

  private constructor(rootDirectory: string) {
    super();
    this.rootDirectory = rootDirectory;
    this.memory = new MemorySaver(this.serde);
  }

  static async open(rootDirectory: string): Promise<FileCheckpointSaver> {
    const saver = new FileCheckpointSaver(rootDirectory);
    await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(rootDirectory);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`checkpoint root must be a real directory: ${rootDirectory}`);
    }
    await chmod(rootDirectory, 0o700);
    const entries = await readdir(rootDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue;
      try {
        await saver.loadFile(entry.name);
      } catch (error) {
        const quarantineName = `${entry.name}.corrupt-${randomUUID()}`;
        await rename(join(rootDirectory, entry.name), join(rootDirectory, quarantineName));
        await chmod(join(rootDirectory, quarantineName), 0o600);
        const message = error instanceof Error ? error.message : "checkpoint load failed with a non-Error value";
        saver.quarantinedFiles.push({ fileName: quarantineName, error: message });
        saver.corruptFiles.set(entry.name, { quarantineName, error: message });
      }
    }
    return saver;
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.pending;
    this.assertThreadIsReadable(requiredThreadId(config));
    return this.memory.getTuple(config);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    await this.pending;
    this.assertThreadIsReadable(requiredThreadId(config));
    for await (const tuple of this.memory.list(config, options)) yield tuple;
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    return this.enqueue(async () => {
      const result = await this.memory.put(config, checkpoint, metadata);
      await this.persistThread(requiredThreadId(result));
      return result;
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return this.enqueue(async () => {
      await this.memory.putWrites(config, writes, taskId);
      await this.persistThread(requiredThreadId(config));
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    return this.enqueue(async () => {
      validateThreadId(threadId);
      await this.memory.deleteThread(threadId);
      const corrupt = this.corruptFiles.get(fileNameForThread(threadId));
      if (corrupt !== undefined) {
        await unlink(join(this.rootDirectory, corrupt.quarantineName));
        this.corruptFiles.delete(fileNameForThread(threadId));
      }
      try {
        await unlink(this.pathForThread(threadId));
      } catch (error) {
        if (!isNodeErrorCode(error, "ENOENT")) throw error;
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadFile(fileName: string): Promise<void> {
    const path = join(this.rootDirectory, fileName);
    const raw = await readBoundedFile(path);
    const value = parseSerializedThread(raw, path);
    if (fileName !== fileNameForThread(value.threadId)) throw new Error(`checkpoint filename does not match its thread id: ${path}`);
    const namespaces: MemorySaver["storage"][string] = Object.create(null);
    const rootWorkflowStates = new Map<string, Readonly<Record<string, unknown>>>();
    for (const [namespace, checkpoints] of Object.entries(value.storage)) {
      const hydrated: MemorySaver["storage"][string][string] = Object.create(null);
      for (const [checkpointId, entry] of Object.entries(checkpoints)) {
        const checkpoint = decode(entry.checkpoint);
        const metadata = decode(entry.metadata);
        const deserializedCheckpoint: unknown = await this.serde.loadsTyped("json", checkpoint);
        const deserializedMetadata: unknown = await this.serde.loadsTyped("json", metadata);
        const channelValues = validateCheckpoint(deserializedCheckpoint, namespace, checkpointId);
        validateCheckpointMetadata(deserializedMetadata);
        if (namespace === "") rootWorkflowStates.set(checkpointId, channelValues);
        hydrated[checkpointId] = [checkpoint, metadata, entry.parentCheckpointId];
      }
      namespaces[namespace] = hydrated;
    }
    const hydratedWrites: Array<[string, MemorySaver["writes"][string]]> = [];
    for (const [outerKey, entries] of Object.entries(value.writes)) {
      const bucket = parseWriteBucketKey(outerKey);
      if (bucket.threadId !== value.threadId) throw new Error(`checkpoint write key belongs to a different thread in ${path}`);
      const hydrated: MemorySaver["writes"][string] = Object.create(null);
      const pendingWorkflowWrites: PersistedWorkflowWrite[] = [];
      for (const entry of entries) {
        const serialized = decode(entry.value);
        const deserializedValue: unknown = await this.serde.loadsTyped("json", serialized);
        pendingWorkflowWrites.push({ channel: entry.channel, value: deserializedValue });
        hydrated[entry.key] = [entry.taskId, entry.channel, serialized];
      }
      if (bucket.namespace === "") {
        const baseState = rootWorkflowStates.get(bucket.checkpointId);
        if (baseState === undefined) throw new Error(`checkpoint writes reference a missing root checkpoint in ${path}`);
        validateEffectiveWorkflowState(baseState, pendingWorkflowWrites);
      }
      hydratedWrites.push([outerKey, hydrated]);
    }
    this.memory.storage[value.threadId] = namespaces;
    for (const [outerKey, writes] of hydratedWrites) this.memory.writes[outerKey] = writes;
    await chmod(path, 0o600);
  }

  private async persistThread(threadId: string): Promise<void> {
    validateThreadId(threadId);
    const storage: MemorySaver["storage"][string] = this.memory.storage[threadId] ?? Object.create(null);
    const serializedStorage: Record<string, Record<string, SerializedCheckpointEntry>> = Object.create(null);
    for (const [namespace, checkpoints] of Object.entries(storage)) {
      const serializedCheckpoints: Record<string, SerializedCheckpointEntry> = Object.create(null);
      for (const [checkpointId, [checkpoint, metadata, parentCheckpointId]] of Object.entries(checkpoints)) {
        serializedCheckpoints[checkpointId] = { checkpoint: encode(checkpoint), metadata: encode(metadata), ...(parentCheckpointId === undefined ? {} : { parentCheckpointId }) };
      }
      serializedStorage[namespace] = serializedCheckpoints;
    }
    const serializedWrites: Record<string, SerializedWriteEntry[]> = Object.create(null);
    for (const [outerKey, writes] of Object.entries(this.memory.writes)) {
      if (parseWriteBucketKey(outerKey).threadId !== threadId) continue;
      serializedWrites[outerKey] = Object.entries(writes).map(([key, [taskId, channel, value]]) => ({ key, taskId, channel, value: encode(value) }));
    }
    const data: SerializedThread = { version: FILE_VERSION, threadId, storage: serializedStorage, writes: serializedWrites };
    await atomicWrite(this.rootDirectory, this.pathForThread(threadId), `${JSON.stringify(data)}\n`);
  }

  private pathForThread(threadId: string): string { return join(this.rootDirectory, fileNameForThread(threadId)); }

  private assertThreadIsReadable(threadId: string): void {
    const corrupt = this.corruptFiles.get(fileNameForThread(threadId));
    if (corrupt !== undefined) throw new Error(`checkpoint is corrupt for thread ${JSON.stringify(threadId)}: ${corrupt.error}`);
  }
}

function requiredThreadId(config: RunnableConfig): string {
  const value = config.configurable?.thread_id;
  if (typeof value !== "string") throw new Error("checkpoint config requires a string thread_id");
  validateThreadId(value);
  return value;
}

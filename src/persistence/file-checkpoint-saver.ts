import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver, MemorySaver, type ChannelVersions, type Checkpoint, type CheckpointListOptions,
  type CheckpointMetadata, type CheckpointTuple, type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { fileNameForThread, parseSerializedThread, validateThreadId } from "./file-checkpoint-format.ts";
import { atomicWrite, checkpointFileFingerprint, isNodeErrorCode, readBoundedFile } from "./checkpoint-file-io.ts";
import { initializeCheckpointDirectory } from "./checkpoint-directory-loader.ts";
import { encodeCheckpointThread, hydrateCheckpointThread } from "./checkpoint-thread-codec.ts";
import {
  CheckpointMetadataBindings, type RepositoryCheckpointIdentity, type ReplaySafetyContext,
} from "./checkpoint-replay-metadata.ts";
import { withCheckpointFileLock } from "./file-lock.ts";
import { requiredThreadId } from "./checkpoint-config.ts";
import { restoreThread, snapshotThread } from "./checkpoint-memory-snapshot.ts";
import {
  claimFromEntry, mutationKey, type MutationClaim, type MutationJournal, type MutationOperation,
  type SerializedMutationEntry,
} from "./mutation-journal.ts";

export class FileCheckpointSaver extends BaseCheckpointSaver implements MutationJournal {
  readonly rootDirectory: string;
  readonly memory: MemorySaver;
  readonly quarantinedFiles: Array<{ readonly fileName: string; readonly error: string }> = [];
  private readonly corruptFiles = new Map<string, { readonly quarantineName: string; readonly error: string }>();
  private readonly mutations = new Map<string, Record<string, SerializedMutationEntry>>();
  private readonly fingerprints = new Map<string, string>();
  private readonly metadataBindings = new CheckpointMetadataBindings();
  private pending: Promise<void> = Promise.resolve();

  private constructor(rootDirectory: string) {
    super();
    this.rootDirectory = rootDirectory;
    this.memory = new MemorySaver(this.serde);
  }

  static async open(rootDirectory: string): Promise<FileCheckpointSaver> {
    const saver = new FileCheckpointSaver(rootDirectory);
    for (const entry of await initializeCheckpointDirectory(rootDirectory, (fileName) => saver.loadFile(fileName))) {
      saver.quarantinedFiles.push({ fileName: entry.quarantineName, error: entry.error });
      saver.corruptFiles.set(entry.sourceName, { quarantineName: entry.quarantineName, error: entry.error });
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

  async listThreads(): Promise<readonly string[]> { await this.pending; return Object.keys(this.memory.storage).sort(); }

  bindRepositorySnapshot(threadId: string, identity: RepositoryCheckpointIdentity): void {
    validateThreadId(threadId); this.metadataBindings.bindRepositorySnapshot(threadId, identity);
  }

  bindReplaySafety(threadId: string, context: ReplaySafetyContext): void {
    validateThreadId(threadId); this.metadataBindings.bindReplaySafety(threadId, context);
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions: ChannelVersions): Promise<RunnableConfig> {
    const threadId = requiredThreadId(config);
    return this.mutateThread(threadId, async () => {
      const snapshot = snapshotThread(this.memory, threadId);
      try {
        const storedMetadata = this.metadataBindings.storedMetadata({
          memory: this.memory,
          config,
          checkpoint,
          metadata,
          threadId,
        });
        const result = await this.memory.put(config, checkpoint, storedMetadata);
        await this.persistThread(threadId);
        return result;
      } catch (error) {
        restoreThread(this.memory, threadId, snapshot);
        throw error;
      }
    });
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requiredThreadId(config);
    return this.mutateThread(threadId, async () => {
      const snapshot = snapshotThread(this.memory, threadId);
      try {
        await this.memory.putWrites(config, writes, taskId);
        await this.persistThread(threadId);
      } catch (error) {
        restoreThread(this.memory, threadId, snapshot);
        throw error;
      }
    });
  }

  async putWritesBatch(
    config: RunnableConfig,
    groups: readonly { readonly taskId: string; readonly writes: PendingWrite[] }[],
  ): Promise<void> {
    const threadId = requiredThreadId(config);
    return this.mutateThread(threadId, async () => {
      const snapshot = snapshotThread(this.memory, threadId);
      try {
        for (const group of groups) await this.memory.putWrites(config, group.writes, group.taskId);
        await this.persistThread(threadId);
      } catch (error) {
        restoreThread(this.memory, threadId, snapshot);
        throw error;
      }
    });
  }

  async deleteThread(threadId: string): Promise<void> {
    validateThreadId(threadId);
    return this.mutateThread(threadId, async () => {
      await this.memory.deleteThread(threadId);
      this.mutations.delete(threadId);
      this.fingerprints.delete(threadId);
      this.metadataBindings.clear(threadId);
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

  async claimMutation(threadId: string, operation: MutationOperation): Promise<MutationClaim> {
    validateThreadId(threadId);
    return this.mutateThread(threadId, async () => {
      const entries = this.mutations.get(threadId) ?? Object.create(null);
      const key = mutationKey(operation);
      const claim = claimFromEntry(entries[key]);
      if (claim.status !== "execute") return claim;
      entries[key] = { status: "started" };
      this.mutations.set(threadId, entries);
      try {
        await this.persistThread(threadId);
      } catch (error) {
        delete entries[key];
        if (Object.keys(entries).length === 0) this.mutations.delete(threadId);
        throw error;
      }
      return claim;
    });
  }

  async completeMutation(threadId: string, operation: MutationOperation, output: string): Promise<void> {
    validateThreadId(threadId);
    return this.mutateThread(threadId, async () => {
      const entries = this.mutations.get(threadId);
      const key = mutationKey(operation);
      if (entries?.[key]?.status !== "started") throw new Error(`mutation ${key} has no active claim`);
      entries[key] = { status: "completed", output };
      try {
        await this.persistThread(threadId);
      } catch (error) {
        entries[key] = { status: "started" };
        throw error;
      }
    });
  }

  private mutateThread<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(() => withCheckpointFileLock(this.rootDirectory, threadId, async () => {
      await this.refreshThread(threadId);
      return operation();
    }));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadFile(fileName: string, source?: string): Promise<void> {
    const path = join(this.rootDirectory, fileName);
    const raw = source ?? await readBoundedFile(path);
    const value = parseSerializedThread(raw, path);
    if (fileName !== fileNameForThread(value.threadId)) throw new Error(`checkpoint filename does not match its thread id: ${path}`);
    this.mutations.set(value.threadId, { ...await hydrateCheckpointThread(this.memory, value, path) });
    this.fingerprints.set(value.threadId, checkpointFileFingerprint(raw));
    await chmod(path, 0o600);
  }

  private async refreshThread(threadId: string): Promise<void> {
    try {
      const fileName = fileNameForThread(threadId);
      const raw = await readBoundedFile(join(this.rootDirectory, fileName));
      if (this.fingerprints.get(threadId) !== checkpointFileFingerprint(raw)) await this.loadFile(fileName, raw);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
      restoreThread(this.memory, threadId, { writes: [] });
      this.mutations.delete(threadId);
      this.fingerprints.delete(threadId);
    }
  }

  private async persistThread(threadId: string): Promise<void> {
    const raw = encodeCheckpointThread(this.memory, threadId, this.mutations.get(threadId) ?? Object.create(null));
    await atomicWrite(this.rootDirectory, this.pathForThread(threadId), raw);
    this.fingerprints.set(threadId, checkpointFileFingerprint(raw));
  }

  private pathForThread(threadId: string): string { return join(this.rootDirectory, fileNameForThread(threadId)); }

  private assertThreadIsReadable(threadId: string): void {
    const corrupt = this.corruptFiles.get(fileNameForThread(threadId));
    if (corrupt !== undefined) throw new Error(`checkpoint is corrupt for thread ${JSON.stringify(threadId)}: ${corrupt.error}`);
  }
}

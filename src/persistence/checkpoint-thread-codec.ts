import type { MemorySaver } from "@langchain/langgraph-checkpoint";
import {
  FILE_VERSION,
  type ParsedSerializedThread,
  type SerializedCheckpointEntry,
  type SerializedThread,
  type SerializedWriteEntry,
  decode,
  encode,
  parseWriteBucketKey,
  validateThreadId,
} from "./file-checkpoint-format.ts";
import { validateCheckpoint, validateCheckpointMetadata } from "./file-checkpoint-validation.ts";
import { restoreThread } from "./checkpoint-memory-snapshot.ts";
import { migrateLegacyMutationJournal } from "./legacy-mutation-migration.ts";
import type { SerializedMutationEntry } from "./mutation-journal.ts";
import { validateEffectiveWorkflowState, type PersistedWorkflowWrite } from "./workflow-pending-write-validation.ts";

export type RepositoryCheckpointIdentity = Readonly<{
  protocolVersion: 1;
  snapshotId: string;
  head: string | null;
}>;

const SNAPSHOT_ID = /^[a-f0-9]{64}$/;
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function repositoryCheckpointIdentity(metadata: unknown): RepositoryCheckpointIdentity | undefined {
  if (typeof metadata !== "object" || metadata === null || !("repositorySnapshot" in metadata)) return undefined;
  const value: unknown = metadata.repositorySnapshot;
  if (typeof value !== "object" || value === null ||
    !("protocolVersion" in value) || value.protocolVersion !== 1 ||
    !("snapshotId" in value) || typeof value.snapshotId !== "string" || !SNAPSHOT_ID.test(value.snapshotId) ||
    !("head" in value) || (value.head !== null && (typeof value.head !== "string" || !GIT_OBJECT_ID.test(value.head)))) {
    throw new Error("invalid checkpoint repository snapshot identity");
  }
  return { protocolVersion: 1, snapshotId: value.snapshotId, head: value.head };
}

export async function hydrateCheckpointThread(
  memory: MemorySaver,
  value: ParsedSerializedThread,
  path: string,
): Promise<Readonly<Record<string, SerializedMutationEntry>>> {
  const namespaces: MemorySaver["storage"][string] = Object.create(null);
  const rootStates = new Map<string, Readonly<Record<string, unknown>>>();
  const pendingRoots = new Set(Object.keys(value.writes).flatMap((key) => {
    const bucket = parseWriteBucketKey(key);
    return bucket.namespace === "" ? [bucket.checkpointId] : [];
  }));
  for (const [namespace, checkpoints] of Object.entries(value.storage)) {
    const hydrated: MemorySaver["storage"][string][string] = Object.create(null);
    for (const [checkpointId, entry] of Object.entries(checkpoints)) {
      const checkpoint = decode(entry.checkpoint);
      const metadata = decode(entry.metadata);
      const decodedCheckpoint: unknown = await memory.serde.loadsTyped("json", checkpoint);
      const decodedMetadata: unknown = await memory.serde.loadsTyped("json", metadata);
      const channels = validateCheckpoint(
        decodedCheckpoint,
        namespace,
        checkpointId,
        namespace !== "" || !pendingRoots.has(checkpointId),
      );
      validateCheckpointMetadata(decodedMetadata);
      repositoryCheckpointIdentity(decodedMetadata);
      if (namespace === "") rootStates.set(checkpointId, channels);
      hydrated[checkpointId] = [checkpoint, metadata, entry.parentCheckpointId];
    }
    namespaces[namespace] = hydrated;
  }
  const hydratedWrites: Array<[string, MemorySaver["writes"][string]]> = [];
  for (const [outerKey, entries] of Object.entries(value.writes)) {
    const bucket = parseWriteBucketKey(outerKey);
    if (bucket.threadId !== value.threadId) throw new Error(`checkpoint write key belongs to a different thread in ${path}`);
    const writes: MemorySaver["writes"][string] = Object.create(null);
    const workflowWrites: PersistedWorkflowWrite[] = [];
    for (const entry of entries) {
      const serialized = decode(entry.value);
      const decoded: unknown = await memory.serde.loadsTyped("json", serialized);
      workflowWrites.push({ channel: entry.channel, value: decoded });
      writes[entry.key] = [entry.taskId, entry.channel, serialized];
    }
    if (bucket.namespace === "") {
      const base = rootStates.get(bucket.checkpointId);
      if (base === undefined) throw new Error(`checkpoint writes reference a missing root checkpoint in ${path}`);
      validateEffectiveWorkflowState(base, workflowWrites);
    }
    hydratedWrites.push([outerKey, writes]);
  }
  restoreThread(memory, value.threadId, { writes: [] });
  memory.storage[value.threadId] = namespaces;
  for (const [key, writes] of hydratedWrites) memory.writes[key] = writes;
  return value.sourceVersion === 1 ? migrateLegacyMutationJournal(rootStates) : { ...value.mutations };
}

export function encodeCheckpointThread(
  memory: MemorySaver,
  threadId: string,
  mutations: Readonly<Record<string, SerializedMutationEntry>>,
): string {
  validateThreadId(threadId);
  const storage: MemorySaver["storage"][string] = memory.storage[threadId] ?? Object.create(null);
  const serializedStorage: Record<string, Record<string, SerializedCheckpointEntry>> = Object.create(null);
  for (const [namespace, checkpoints] of Object.entries(storage)) {
    const serialized: Record<string, SerializedCheckpointEntry> = Object.create(null);
    for (const [checkpointId, [checkpoint, metadata, parentCheckpointId]] of Object.entries(checkpoints)) {
      serialized[checkpointId] = { checkpoint: encode(checkpoint), metadata: encode(metadata), ...(parentCheckpointId === undefined ? {} : { parentCheckpointId }) };
    }
    serializedStorage[namespace] = serialized;
  }
  const serializedWrites: Record<string, SerializedWriteEntry[]> = Object.create(null);
  for (const [outerKey, writes] of Object.entries(memory.writes)) {
    if (parseWriteBucketKey(outerKey).threadId !== threadId) continue;
    serializedWrites[outerKey] = Object.entries(writes).map(([key, [taskId, channel, value]]) => ({ key, taskId, channel, value: encode(value) }));
  }
  const data: SerializedThread = {
    version: FILE_VERSION,
    threadId,
    storage: serializedStorage,
    writes: serializedWrites,
    mutations,
  };
  return `${JSON.stringify(data)}\n`;
}

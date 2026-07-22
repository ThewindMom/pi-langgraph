import type { MemorySaver } from "@langchain/langgraph-checkpoint";
import { parseWriteBucketKey } from "./file-checkpoint-format.ts";

export interface ThreadSnapshot {
  readonly storage?: MemorySaver["storage"][string];
  readonly writes: ReadonlyArray<readonly [string, MemorySaver["writes"][string]]>;
}

export function snapshotThread(memory: MemorySaver, threadId: string): ThreadSnapshot {
  const currentStorage = memory.storage[threadId];
  const storage = currentStorage === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(currentStorage).map(([namespace, checkpoints]) => [
          namespace,
          Object.assign(Object.create(null), checkpoints),
        ]),
      );
  const writes = Object.entries(memory.writes)
    .filter(([key]) => parseWriteBucketKey(key).threadId === threadId)
    .map(([key, bucket]) => [key, Object.assign(Object.create(null), bucket)] as const);
  return { ...(storage === undefined ? {} : { storage }), writes };
}

export function restoreThread(memory: MemorySaver, threadId: string, snapshot: ThreadSnapshot): void {
  if (snapshot.storage === undefined) delete memory.storage[threadId];
  else memory.storage[threadId] = snapshot.storage;
  for (const key of Object.keys(memory.writes)) {
    if (parseWriteBucketKey(key).threadId === threadId) delete memory.writes[key];
  }
  for (const [key, writes] of snapshot.writes) memory.writes[key] = writes;
}

import { createHash } from "node:crypto";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";

export type MutationKind = "implement" | "repair";

export interface MutationOperation {
  readonly kind: MutationKind;
  readonly iteration: number;
  readonly workspaceId?: string;
  readonly planId?: string;
  readonly changeId?: string;
  readonly attempt?: number;
}

export type MutationClaim =
  | { readonly status: "execute" }
  | { readonly status: "replay"; readonly output: string }
  | { readonly status: "indeterminate" };

export type MutationExecution =
  | { readonly status: "completed"; readonly output: string }
  | { readonly status: "indeterminate" };

export type SerializedMutationEntry =
  | { readonly status: "started" }
  | { readonly status: "completed"; readonly output: string };

export interface MutationJournal {
  claimMutation(threadId: string, operation: MutationOperation): Promise<MutationClaim>;
  completeMutation(threadId: string, operation: MutationOperation, output: string): Promise<void>;
}

const memoryJournals = new WeakMap<BaseCheckpointSaver, MemoryMutationJournal>();
const unsupportedJournal: MutationJournal = {
  async claimMutation(): Promise<MutationClaim> {
    throw new Error("mutating workflows require durable mutation claim methods on custom checkpointers");
  },
  async completeMutation(): Promise<void> {
    throw new Error("mutating workflows require durable mutation claim methods on custom checkpointers");
  },
};

export function mutationJournalFor(checkpointer: BaseCheckpointSaver): MutationJournal {
  if (isMutationJournal(checkpointer)) return checkpointer;
  if (!(checkpointer instanceof MemorySaver)) return unsupportedJournal;
  const existing = memoryJournals.get(checkpointer);
  if (existing !== undefined) return existing;
  const created = new MemoryMutationJournal();
  memoryJournals.set(checkpointer, created);
  return created;
}

export async function deleteMutationJournalThread(
  checkpointer: BaseCheckpointSaver,
  threadId: string,
): Promise<void> {
  if (checkpointer instanceof MemorySaver) await memoryJournals.get(checkpointer)?.deleteMutationThread(threadId);
  else if (hasMutationDeletion(checkpointer)) await checkpointer.deleteMutationThread(threadId);
}

export function mutationKey(operation: MutationOperation): string {
  if (!Number.isSafeInteger(operation.iteration) || operation.iteration < 0) {
    throw new Error("mutation iteration must be a non-negative safe integer");
  }
  const { workspaceId, planId, changeId, attempt } = operation;
  if (workspaceId === undefined && planId === undefined && changeId === undefined && attempt === undefined) {
    return `${operation.kind}:${operation.iteration}`;
  }
  if (workspaceId === undefined || planId === undefined || changeId === undefined || attempt === undefined) {
    throw new Error("scoped mutation identity requires workspaceId, planId, changeId, and attempt");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) {
    throw new Error("mutation workspaceId must be a 1-128 character lexical identifier");
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(planId)) {
    throw new Error("mutation planId must be a 1-128 character lexical identifier");
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(changeId)) {
    throw new Error("mutation changeId must be a 1-48 character lexical identifier");
  }
  if (!Number.isSafeInteger(attempt) || attempt < 0) {
    throw new Error("mutation attempt must be a non-negative safe integer");
  }
  const identity = createHash("sha256").update(`${workspaceId}\0${planId}\0${changeId}`).digest("hex");
  return `v3:${identity}:${operation.kind}:${attempt}`;
}

export function claimFromEntry(entry: SerializedMutationEntry | undefined): MutationClaim {
  if (entry === undefined) return { status: "execute" };
  if (entry.status === "completed") return { status: "replay", output: entry.output };
  return { status: "indeterminate" };
}

class MemoryMutationJournal implements MutationJournal {
  private readonly threads = new Map<string, Map<string, SerializedMutationEntry>>();

  async claimMutation(threadId: string, operation: MutationOperation): Promise<MutationClaim> {
    const entries = this.threads.get(threadId) ?? new Map<string, SerializedMutationEntry>();
    const key = mutationKey(operation);
    const claim = claimFromEntry(entries.get(key));
    if (claim.status === "execute") {
      entries.set(key, { status: "started" });
      this.threads.set(threadId, entries);
    }
    return claim;
  }

  async completeMutation(threadId: string, operation: MutationOperation, output: string): Promise<void> {
    const entries = this.threads.get(threadId);
    const key = mutationKey(operation);
    if (entries?.get(key)?.status !== "started") throw new Error(`mutation ${key} has no active claim`);
    entries.set(key, { status: "completed", output });
  }

  async deleteMutationThread(threadId: string): Promise<void> { this.threads.delete(threadId); }
}

function isMutationJournal(value: BaseCheckpointSaver): value is BaseCheckpointSaver & MutationJournal {
  return (
    "claimMutation" in value &&
    typeof value.claimMutation === "function" &&
    "completeMutation" in value &&
    typeof value.completeMutation === "function"
  );
}

function hasMutationDeletion(
  value: BaseCheckpointSaver,
): value is BaseCheckpointSaver & { deleteMutationThread(threadId: string): Promise<void> } {
  return "deleteMutationThread" in value && typeof value.deleteMutationThread === "function";
}

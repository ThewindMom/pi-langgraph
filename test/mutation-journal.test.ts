import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import { parseSerializedThread } from "../src/persistence/file-checkpoint-format.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import type { MutationClaim, MutationJournal, MutationOperation } from "../src/persistence/mutation-journal.ts";
import type { TaskExecutor } from "../src/types.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";

test("replays a completed mutation after its journal commit but before the graph checkpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-completed-replay-"));
  let implementationCalls = 0;
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover":
          return JSON.stringify({ workItems: [{ id: "core", title: "Core", instruction: "Inspect" }], acceptanceCriteria: ["passes"] });
        case "specialist_core":
          return JSON.stringify({ summary: "found", evidence: [], risks: [], discoveredWorkItems: [] });
        case "implement":
          implementationCalls += 1;
          return JSON.stringify({ summary: "done", filesChanged: ["core.ts"], evidence: ["done"], unresolvedRisks: [] });
        case "verify":
          return JSON.stringify({ passed: true, summary: "passed", checks: [{ name: "check", passed: true, evidence: "exit 0" }] });
        case "synthesize":
          return JSON.stringify({ summary: "completed" });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  try {
    const directory = join(root, "checkpoints");
    const durable = await FileCheckpointSaver.open(directory);
    const crashing = new CrashAfterCompletionSaver(durable);
    await expect(runCodingWorkflow(
      { objective: "Implement core" },
      executor,
      { checkpointer: crashing, threadId: "completed-replay", retainCheckpoint: true },
    )).rejects.toThrow("crash after mutation result persistence");

    const reopened = await FileCheckpointSaver.open(directory);
    const result = await resumeCodingWorkflow("completed-replay", executor, {
      checkpointer: reopened,
      retainCheckpoint: true,
    });
    expect(result.status).toBe("completed");
    expect(implementationCalls).toBe(1);
    if (result.status !== "completed") throw new Error("workflow did not complete");
    expect(result.changes[0]?.summary).toBe("done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizes a valid version-one checkpoint file to an empty mutation journal", () => {
  const parsed = parseSerializedThread(
    JSON.stringify({ version: 1, threadId: "legacy", storage: {}, writes: {} }),
    "legacy.checkpoint.json",
  );
  expect(parsed.version).toBe(2);
  expect(parsed.mutations).toEqual({});
});

test("deleting a completed MemorySaver thread also clears its mutation journal", async () => {
  const saver = new MemorySaver();
  let implementationCalls = 0;
  const executor: TaskExecutor = {
    async execute(request) {
      switch (request.task.id) {
        case "discover":
          return JSON.stringify({ workItems: [{ id: "core", title: "Core", instruction: "Inspect" }], acceptanceCriteria: ["passes"] });
        case "specialist_core":
          return JSON.stringify({ summary: "found", evidence: [], risks: [], discoveredWorkItems: [] });
        case "implement":
          implementationCalls += 1;
          return JSON.stringify({ summary: `change-${implementationCalls}`, filesChanged: ["core.ts"], evidence: ["done"], unresolvedRisks: [] });
        case "verify":
          return JSON.stringify({ passed: true, summary: "passed", checks: [{ name: "check", passed: true, evidence: "exit 0" }] });
        case "synthesize":
          return JSON.stringify({ summary: "completed" });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };

  await runCodingWorkflow(
    { objective: "First implementation" },
    executor,
    { checkpointer: saver, threadId: "reused-memory-thread" },
  );
  const second = await runCodingWorkflow(
    { objective: "Second implementation" },
    executor,
    { checkpointer: saver, threadId: "reused-memory-thread", retainCheckpoint: true },
  );
  expect(implementationCalls).toBe(2);
  if (second.status !== "completed") throw new Error("second workflow did not complete");
  expect(second.changes[0]?.summary).toBe("change-2");
});

class CrashAfterCompletionSaver extends BaseCheckpointSaver implements MutationJournal {
  private crashed = false;

  constructor(private readonly delegate: FileCheckpointSaver) { super(); }

  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> { return this.delegate.getTuple(config); }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    for await (const tuple of this.delegate.list(config, options)) yield tuple;
  }

  put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, versions: ChannelVersions): Promise<RunnableConfig> {
    return this.delegate.put(config, checkpoint, metadata, versions);
  }

  putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return this.delegate.putWrites(config, writes, taskId);
  }

  deleteThread(threadId: string): Promise<void> { return this.delegate.deleteThread(threadId); }

  claimMutation(threadId: string, operation: MutationOperation): Promise<MutationClaim> {
    return this.delegate.claimMutation(threadId, operation);
  }

  async completeMutation(threadId: string, operation: MutationOperation, output: string): Promise<void> {
    await this.delegate.completeMutation(threadId, operation, output);
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("crash after mutation result persistence");
    }
  }
}

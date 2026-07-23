import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata, CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import { createOrchestrationDispatcher } from "../src/runtime/orchestration-dispatcher.ts";
import {
  bindNewWorkflowReplay,
  ReplayResumeRejectedError,
} from "../src/runtime/replay-context.ts";
import { REPOSITORY_ONLY_EFFECT_LEDGER } from "../src/runtime/task-execution-effects.ts";
import type { LangGraphExtensionAPI } from "../src/types.ts";

describe("runtime replay resume gate", () => {
  test("rejects incompatible model configuration before any worker execution", async () => {
    // Given: a checkpoint bound to one exact graph/tool/model/config and repository identity.
    const fixture = await replayFixture("model-mismatch");
    const checkpoints = await FileCheckpointSaver.open(join(fixture.dataRoot, "checkpoints"));
    const snapshots = await RepositorySnapshotStore.open(fixture.dataRoot);
    await bindNewWorkflowReplay({
      checkpoints,
      snapshotStore: snapshots,
      threadId: "resume-thread",
      sourceDirectory: fixture.repository,
      workflowInput: { objective: "resume safely", workflow: "delivery" },
      policy: policy("model-a"),
      effectLedger: REPOSITORY_ONLY_EFFECT_LEDGER,
    });
    await checkpoints.put(
      { configurable: { thread_id: "resume-thread" } },
      checkpoint("checkpoint-a"),
      metadata,
      {},
    );
    let workerStarts = 0;
    const dispatcher = createOrchestrationDispatcher(pi(() => {
      workerStarts += 1;
    }), fixture.dataRoot);

    try {
      // When: the caller resumes under a different model configuration.
      const action = dispatcher({
        input: { resumeThreadId: "resume-thread" },
        context: { cwd: fixture.repository, model: undefined },
      });

      // Then: replay is rejected before graph compilation can execute a worker.
      await expect(action).rejects.toMatchObject({
        name: "ReplayResumeRejectedError",
        reason: "tool-model-config-mismatch",
      });
      expect(workerStarts).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("keeps old checkpoints inspectable but explicitly rejects resume", async () => {
    // Given: a structurally valid legacy checkpoint without replay metadata.
    const fixture = await replayFixture("legacy");
    const checkpoints = await FileCheckpointSaver.open(join(fixture.dataRoot, "checkpoints"));
    await checkpoints.put(
      { configurable: { thread_id: "legacy-thread" } },
      checkpoint("legacy-checkpoint"),
      metadata,
      {},
    );
    const history = [...await collect(checkpoints, "legacy-thread")];
    let workerStarts = 0;
    const dispatcher = createOrchestrationDispatcher(pi(() => {
      workerStarts += 1;
    }), fixture.dataRoot);

    try {
      // When: resume is attempted through the public runtime path.
      const action = dispatcher({
        input: { resumeThreadId: "legacy-thread" },
        context: { cwd: fixture.repository, model: undefined },
      });

      // Then: history remains readable while execution fails closed before a worker starts.
      expect(history.map((tuple) => tuple.checkpoint.id)).toEqual(["legacy-checkpoint"]);
      await expect(action).rejects.toBeInstanceOf(ReplayResumeRejectedError);
      await expect(action).rejects.toMatchObject({ reason: "missing-replay-metadata" });
      expect(workerStarts).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});

const metadata: CheckpointMetadata = { source: "loop", step: 0, parents: {} };

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

function policy(modelId: string) {
  return {
    adapter: "native",
    inheritedModel: { provider: "test", id: modelId, api: "test-api" },
    activeTools: ["task"],
    protocol: "pi-langgraph.worker.v1",
  } as const;
}

function pi(onWorker: () => void): LangGraphExtensionAPI {
  return {
    registerTool() {},
    getActiveTools: () => ["task"],
    async executeTool() {
      onWorker();
      return { content: [{ type: "text", text: "{}" }], details: { status: "completed" } };
    },
  };
}

async function replayFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pi-replay-${name}-`));
  const repository = join(root, "repository");
  const dataRoot = join(root, "data");
  await mkdir(repository);
  await writeFile(join(repository, "tracked.txt"), "baseline\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  return {
    repository,
    dataRoot,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

async function collect(checkpoints: FileCheckpointSaver, threadId: string) {
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of checkpoints.list({ configurable: { thread_id: threadId } })) tuples.push(tuple);
  return tuples;
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

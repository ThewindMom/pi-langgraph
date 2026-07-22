import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";

test("resumes a dynamic map after process-style restart without rerunning successful siblings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-resume-"));
  const counts = new Map<string, number>();
  let interrupted = true;
  const executor: TaskExecutor = {
    async execute(request) {
      counts.set(request.task.id, (counts.get(request.task.id) ?? 0) + 1);
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: [
            { id: "client", title: "Client", instruction: "Inspect client" },
            { id: "server", title: "Server", instruction: "Inspect server" },
            { id: "schema", title: "Schema", instruction: "Inspect schema" },
          ],
          acceptanceCriteria: ["all layers agree"],
        });
      }
      if (request.task.id.startsWith("specialist_")) {
        if (request.task.id === "specialist_schema" && interrupted) throw new Error("simulated interruption");
        return JSON.stringify({ summary: request.task.id, evidence: [], risks: [] });
      }
      if (request.task.id === "implement") {
        return JSON.stringify({
          summary: "implemented",
          filesChanged: ["src/app.ts"],
          evidence: ["updated contract"],
          unresolvedRisks: [],
        });
      }
      if (request.task.id === "verify") {
        return JSON.stringify({
          passed: true,
          summary: "passed",
          checks: [{ name: "tests", passed: true, evidence: "exit 0" }],
        });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "resumed and completed" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  try {
    const firstSaver = await FileCheckpointSaver.open(join(root, "checkpoints"));
    await expect(
      runCodingWorkflow(
        { objective: "Update client, server, and schema" },
        executor,
        { checkpointer: firstSaver, threadId: "durable-thread", retainCheckpoint: true },
      ),
    ).rejects.toThrow("simulated interruption");

    const checkpointDirectory = join(root, "checkpoints");
    const files = await readdir(checkpointDirectory);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.checkpoint\.json$/);
    expect((await stat(checkpointDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(checkpointDirectory, files[0] ?? "missing"))).mode & 0o777).toBe(0o600);

    interrupted = false;
    const reopenedSaver = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const result = await resumeCodingWorkflow("durable-thread", executor, {
      checkpointer: reopenedSaver,
      retainCheckpoint: true,
    });

    expect(result.status).toBe("completed");
    expect(result.findings).toHaveLength(3);
    expect(counts.get("discover")).toBe(1);
    expect(counts.get("specialist_client")).toBe(1);
    expect(counts.get("specialist_server")).toBe(1);
    expect(counts.get("specialist_schema")).toBe(3);
    const latest = await reopenedSaver.getTuple({ configurable: { thread_id: "durable-thread" } });
    expect(latest?.checkpoint.channel_values.status).toBe("completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

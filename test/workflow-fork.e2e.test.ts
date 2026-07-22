import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySaver, type Checkpoint, type CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { forkWorkflowCheckpoint } from "../src/workflow/forks.ts";
import { WorktreeManager } from "../src/workspace/worktree-manager.ts";

test("forks a retained checkpoint into an isolated Git worktree without changing source bytes or history", async () => {
  // Given: a clean source repository at the revision retained by a checkpoint.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-worktree-fork-"));
  const sourceCwd = join(root, "source");
  const worktreeRoot = join(root, "extension-worktrees");

  try {
    await mkdir(sourceCwd);
    await Bun.write(join(sourceCwd, "feature.ts"), "export const branch = 'source';\n");
    runGit(sourceCwd, ["init"]);
    runGit(sourceCwd, ["config", "user.name", "Pi LangGraph Test"]);
    runGit(sourceCwd, ["config", "user.email", "pi-langgraph@example.invalid"]);
    runGit(sourceCwd, ["add", "."]);
    runGit(sourceCwd, ["commit", "-m", "retained checkpoint source"]);
    const sourceHead = runGit(sourceCwd, ["rev-parse", "HEAD"]);
    const sourceHistory = runGit(sourceCwd, ["log", "--format=%H"]);
    const sourceBytes = await readFile(join(sourceCwd, "feature.ts"));
    const manager = await WorktreeManager.open(worktreeRoot);

    // When: the checkpoint is forked and the child mutates and commits in its workspace.
    const manifest = await manager.createFork({
      sourceCwd,
      sourceThreadId: "source-thread",
      checkpointId: "langgraph-checkpoint",
      gitCommit: sourceHead,
      forkThreadId: "fork-thread",
    });
    await writeFile(join(manifest.workspacePath, "feature.ts"), "export const branch = 'fork';\n");
    runGit(manifest.workspacePath, ["add", "feature.ts"]);
    runGit(manifest.workspacePath, ["commit", "-m", "fork-only change"]);

    // Then: identities are bound, histories diverge, and source bytes/history/status remain exact.
    expect(manifest).toMatchObject({
      sourceThreadId: "source-thread",
      checkpointId: "langgraph-checkpoint",
      gitCommit: sourceHead,
      forkThreadId: "fork-thread",
    });
    expect(manifest.workspacePath).not.toBe(sourceCwd);
    expect(runGit(manifest.workspacePath, ["rev-parse", "HEAD"])).not.toBe(sourceHead);
    expect(runGit(sourceCwd, ["rev-parse", "HEAD"])).toBe(sourceHead);
    expect(runGit(sourceCwd, ["log", "--format=%H"])).toBe(sourceHistory);
    expect(await readFile(join(sourceCwd, "feature.ts"))).toEqual(sourceBytes);
    expect(runGit(sourceCwd, ["status", "--porcelain=v1"])).toBe("");

    await manager.cleanup("fork-thread");
    expect(runGit(sourceCwd, ["worktree", "list", "--porcelain"])).not.toContain(manifest.workspacePath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forks only the selected checkpoint ancestors when later descendants exist", async () => {
  // Given: three checkpoints where the selected middle checkpoint is bound to the repository HEAD.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-checkpoint-fork-"));
  const sourceCwd = join(root, "source");
  try {
    await mkdir(sourceCwd);
    await writeFile(join(sourceCwd, "feature.ts"), "export const source = true;\n");
    runGit(sourceCwd, ["init"]);
    runGit(sourceCwd, ["config", "user.name", "Pi LangGraph Test"]);
    runGit(sourceCwd, ["config", "user.email", "pi-langgraph@example.invalid"]);
    runGit(sourceCwd, ["add", "."]);
    runGit(sourceCwd, ["commit", "-m", "source"]);
    const head = runGit(sourceCwd, ["rev-parse", "HEAD"]);
    const checkpointer = new MemorySaver();
    const repositorySnapshot = { protocolVersion: 1, snapshotId: "a".repeat(64), head } as const;
    const metadata = (step: number): CheckpointMetadata<{ readonly repositorySnapshot: typeof repositorySnapshot }> => ({
      source: "loop", step, parents: {}, repositorySnapshot,
    });
    const first = await checkpointer.put(
      { configurable: { thread_id: "source-thread" } }, checkpoint("checkpoint-one"), metadata(0),
    );
    const second = await checkpointer.put(first, checkpoint("checkpoint-two"), metadata(1));
    await checkpointer.put(second, checkpoint("checkpoint-three"), metadata(2));
    const manager = await WorktreeManager.open(join(root, "forks"));

    // When: the non-latest middle checkpoint is forked.
    await forkWorkflowCheckpoint({
      checkpointer,
      worktreeManager: manager,
      sourceCwd,
      sourceThreadId: "source-thread",
      checkpointId: "checkpoint-two",
      gitCommit: head,
      forkThreadId: "fork-thread",
    });

    // Then: its parent is copied, but its later descendant is excluded.
    const copied: string[] = [];
    for await (const tuple of checkpointer.list({ configurable: { thread_id: "fork-thread" } })) {
      copied.push(tuple.checkpoint.id);
    }
    expect(copied.sort()).toEqual(["checkpoint-one", "checkpoint-two"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function checkpoint(id: string): Checkpoint {
  return { v: 4, id, ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} };
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

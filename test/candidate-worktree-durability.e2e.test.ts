import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import { CandidateWorktreeManager } from "../src/workspace/candidate-worktree-manager.ts";

const CREATE_PAIR_PROCESS = `
import { RepositorySnapshotStore } from "./src/repository/repository-snapshot-store.ts";
import { CandidateWorktreeManager } from "./src/workspace/candidate-worktree-manager.ts";
const [managerRoot, dataRoot, repository, snapshotJson] = Bun.argv.slice(1);
await Bun.stdin.text();
const store = await RepositorySnapshotStore.open(dataRoot);
const manager = await CandidateWorktreeManager.open(managerRoot);
const pair = await manager.createPair({
  requestId: "cross-process",
  sourceCwd: repository,
  sourceThreadId: "source-thread",
  checkpointId: "selected-checkpoint",
  retentionOwnerIds: ["candidate-owner-0", "candidate-owner-1"],
  snapshot: JSON.parse(snapshotJson),
  snapshotStore: store,
});
console.log(JSON.stringify(pair.candidates.map(({ candidateIndex, workspacePath }) => ({ candidateIndex, workspacePath }))));
`;

const SET_STATUS_PROCESS = `
import { CandidateWorktreeManager } from "./src/workspace/candidate-worktree-manager.ts";
const [managerRoot, candidateIndexText, statusJson] = Bun.argv.slice(1);
await Bun.stdin.text();
const manager = await CandidateWorktreeManager.open(managerRoot);
const candidateIndex = candidateIndexText === "0" ? 0 : 1;
await manager.setStatus("status-race", candidateIndex, JSON.parse(statusJson));
`;

describe("candidate worktree durability", () => {
  test("serializes simultaneous pair creation across independent processes", async () => {
    // Given: two independent processes opened over one manager root and one captured snapshot.
    const fixture = await fixtureRepository("cross-process");
    try {
      const dataRoot = join(fixture.root, "data");
      const managerRoot = join(fixture.root, "manager");
      const store = await RepositorySnapshotStore.open(dataRoot);
      const snapshot = await store.capture(fixture.repository);
      const command = [
        process.execPath,
        "--eval",
        CREATE_PAIR_PROCESS,
        managerRoot,
        dataRoot,
        fixture.repository,
        JSON.stringify(snapshot),
      ];
      const first = Bun.spawn(command, { cwd: import.meta.dir + "/..", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const second = Bun.spawn(command, { cwd: import.meta.dir + "/..", stdin: "pipe", stdout: "pipe", stderr: "pipe" });

      // When: both processes are released into createPair at the same barrier.
      first.stdin.end();
      second.stdin.end();
      const [firstExit, secondExit, firstOutput, secondOutput, firstError, secondError] = await Promise.all([
        first.exited,
        second.exited,
        new Response(first.stdout).text(),
        new Response(second.stdout).text(),
        new Response(first.stderr).text(),
        new Response(second.stderr).text(),
      ]);

      // Then: both observe one identical durable pair and exactly two registered worktrees persist.
      expect({ firstExit, secondExit, firstError, secondError }).toEqual({
        firstExit: 0,
        secondExit: 0,
        firstError: "",
        secondError: "",
      });
      expect(JSON.parse(firstOutput)).toEqual(JSON.parse(secondOutput));
      const pair = await (await CandidateWorktreeManager.open(managerRoot)).getPair("cross-process");
      expect(pair?.candidates.map((candidate) => candidate.candidateIndex)).toEqual([0, 1]);
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"]))
        .toContain(pair?.candidates[0].workspacePath ?? "missing-candidate-0");
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"]))
        .toContain(pair?.candidates[1].workspacePath ?? "missing-candidate-1");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves simultaneous status transitions from independent processes", async () => {
    // Given: one durable pair and two processes targeting different candidates.
    const fixture = await fixtureRepository("status-race");
    try {
      const dataRoot = join(fixture.root, "data");
      const managerRoot = join(fixture.root, "manager");
      const store = await RepositorySnapshotStore.open(dataRoot);
      const manager = await CandidateWorktreeManager.open(managerRoot);
      const snapshot = await store.capture(fixture.repository);
      await manager.createPair({
        requestId: "status-race",
        sourceCwd: fixture.repository,
        sourceThreadId: "source-thread",
        checkpointId: "selected-checkpoint",
        retentionOwnerIds: ["status-owner-0", "status-owner-1"],
        snapshot,
        snapshotStore: store,
      });
      const first = Bun.spawn([
        process.execPath,
        "--eval",
        SET_STATUS_PROCESS,
        managerRoot,
        "0",
        JSON.stringify({ protocolVersion: 1, kind: "winner", finalized: true }),
      ], { cwd: import.meta.dir + "/..", stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const second = Bun.spawn([
        process.execPath,
        "--eval",
        SET_STATUS_PROCESS,
        managerRoot,
        "1",
        JSON.stringify({ protocolVersion: 1, kind: "loser" }),
      ], { cwd: import.meta.dir + "/..", stdin: "pipe", stdout: "pipe", stderr: "pipe" });

      // When: both processes cross the status-transition barrier simultaneously.
      first.stdin.end();
      second.stdin.end();
      const exits = await Promise.all([first.exited, second.exited]);

      // Then: neither read-modify-write transition overwrites the other.
      expect(exits).toEqual([0, 0]);
      expect((await manager.getPair("status-race"))?.candidates.map((candidate) => candidate.status)).toEqual([
        { protocolVersion: 1, kind: "winner", finalized: true },
        { protocolVersion: 1, kind: "loser" },
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves a pinned winner checkpoint across restart and releases only the expired loser owner", async () => {
    // Given: a promoted pair with a pinned winner, unpinned loser, and durable candidate checkpoints.
    const fixture = await fixtureRepository("retention");
    let now = 100;
    try {
      const dataRoot = join(fixture.root, "data");
      const managerRoot = join(fixture.root, "manager");
      const checkpointRoot = join(fixture.root, "checkpoints");
      const store = await RepositorySnapshotStore.open(dataRoot);
      const snapshot = await store.capture(fixture.repository);
      const manager = await CandidateWorktreeManager.open(managerRoot, { clock: () => now, ttlMs: 10 });
      const pair = await manager.createPair({
        requestId: "retained-promotion",
        sourceCwd: fixture.repository,
        sourceThreadId: "source-thread",
        checkpointId: "selected-checkpoint",
        retentionOwnerIds: ["winner-thread", "loser-thread"],
        snapshot,
        snapshotStore: store,
      });
      const checkpoints = await FileCheckpointSaver.open(checkpointRoot);
      await putCheckpoint(checkpoints, "winner-thread", "winner-checkpoint");
      await putCheckpoint(checkpoints, "loser-thread", "loser-checkpoint");
      await manager.setStatus("retained-promotion", 0, { protocolVersion: 1, kind: "winner", finalized: true });
      await manager.setStatus("retained-promotion", 1, { protocolVersion: 1, kind: "loser" });
      await manager.setPinned("retained-promotion", 1, false);
      now = 111;

      // When: a restarted manager performs expiry and production-style owner release.
      const restarted = await CandidateWorktreeManager.open(managerRoot, { clock: () => now, ttlMs: 10 });
      const cleanup = await restarted.cleanupExpired();
      for (const ownerId of cleanup.releaseOwnerIds) await checkpoints.deleteThread(ownerId);

      // Then: only the loser is removed; winner worktree, pin, and checkpoint remain durable.
      expect(cleanup.removed).toEqual([{ requestId: "retained-promotion", candidateIndex: 1 }]);
      expect(cleanup.releaseOwnerIds).toEqual(["loser-thread"]);
      expect((await restarted.getPair("retained-promotion"))?.candidates).toMatchObject([
        { pinned: true, removedAtMs: null, status: { kind: "winner", finalized: true } },
        { pinned: false, removedAtMs: 111, status: { kind: "loser" } },
      ]);
      expect(await checkpoints.listThreads()).toEqual(["winner-thread"]);
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).toContain(pair.candidates[0].workspacePath);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function fixtureRepository(name: string): Promise<Readonly<{ root: string; repository: string }>> {
  const root = await mkdtemp(join(tmpdir(), `pi-candidate-durability-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "tracked.txt"), "baseline\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  return { root, repository };
}

async function putCheckpoint(checkpoints: FileCheckpointSaver, threadId: string, checkpointId: string): Promise<void> {
  await checkpoints.put(
    { configurable: { thread_id: threadId } },
    { v: 4, id: checkpointId, ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} },
    { source: "loop", step: 0, parents: {} },
    {},
  );
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

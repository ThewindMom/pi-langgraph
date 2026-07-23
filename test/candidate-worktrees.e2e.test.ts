import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import {
  CandidateWorktreeManager,
  type CandidateLifecycleStatus,
} from "../src/workspace/candidate-worktree-manager.ts";

describe("CandidateWorktreeManager", () => {
  test("creates exactly two candidates deterministically from one dirty snapshot without changing the source", async () => {
    // Given: one captured dirty repository and an injected clock.
    const fixture = await fixtureRepository("dirty");
    try {
      await writeFile(join(fixture.repository, "tracked.txt"), "dirty bytes\n");
      await writeFile(join(fixture.repository, "untracked.txt"), "untracked bytes\n");
      const sourceHead = git(fixture.repository, ["rev-parse", "HEAD"]);
      const sourceStatus = git(fixture.repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const store = await RepositorySnapshotStore.open(join(fixture.root, "data"));
      const snapshot = await store.capture(fixture.repository);
      const managerRoot = join(fixture.root, "candidate-manager");
      const manager = await CandidateWorktreeManager.open(managerRoot, {
        clock: () => 10_000,
        ttlMs: 5_000,
      });
      const input = {
        requestId: "request-dirty",
        sourceCwd: fixture.repository,
        sourceThreadId: "source-thread",
        checkpointId: "checkpoint-dirty",
        retentionOwnerIds: ["request-dirty-0", "request-dirty-1"],
        snapshot,
        snapshotStore: store,
      } as const;

      // When: one request creates its candidate pair.
      const pair = await manager.createPair(input);
      const repeated = await manager.createPair(input);

      // Then: there are exactly two stable, versioned worktrees with identical snapshot bytes.
      expect(repeated).toEqual(pair);
      expect(pair.protocolVersion).toBe(1);
      expect(pair).toMatchObject({
        sourceThreadId: "source-thread",
        checkpointId: "checkpoint-dirty",
        retentionOwnerIds: ["request-dirty-0", "request-dirty-1"],
      });
      expect(pair.candidates.map((candidate) => candidate.candidateIndex)).toEqual([0, 1]);
      expect(pair.candidates.map((candidate) => candidate.workspacePath)).toEqual([
        join(managerRoot, "worktrees", "request-dirty-0"),
        join(managerRoot, "worktrees", "request-dirty-1"),
      ]);
      expect((await readdir(join(managerRoot, "worktrees"))).sort()).toEqual(["request-dirty-0", "request-dirty-1"]);
      for (const candidate of pair.candidates) {
        expect(candidate.status).toEqual({ protocolVersion: 1, kind: "active" });
        expect(candidate.lease).toEqual({ protocolVersion: 1, expiresAtMs: 15_000 });
        expect(await readFile(join(candidate.workspacePath, "tracked.txt"), "utf8")).toBe("dirty bytes\n");
        expect(await readFile(join(candidate.workspacePath, "untracked.txt"), "utf8")).toBe("untracked bytes\n");
        expect(git(candidate.workspacePath, ["rev-parse", "HEAD"])).toBe(sourceHead);
      }
      expect(git(fixture.repository, ["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(git(fixture.repository, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(sourceStatus);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("creates two unborn Git candidates without manufacturing a commit", async () => {
    // Given: a repository whose HEAD is unborn.
    const root = await mkdtemp(join(tmpdir(), "pi-candidates-unborn-"));
    const repository = join(root, "repository");
    try {
      await mkdir(repository);
      git(repository, ["init"]);
      await writeFile(join(repository, "draft.txt"), "first draft\n");
      const store = await RepositorySnapshotStore.open(join(root, "data"));
      const snapshot = await store.capture(repository);
      const manager = await CandidateWorktreeManager.open(join(root, "manager"), {
        clock: () => 1,
        ttlMs: 10,
      });

      // When: the snapshot is materialized as a pair.
      const pair = await manager.createPair({
        requestId: "request-unborn",
        sourceCwd: repository,
        sourceThreadId: "source-thread",
        checkpointId: "checkpoint-unborn",
        retentionOwnerIds: ["request-unborn-0", "request-unborn-1"],
        snapshot,
        snapshotStore: store,
      });

      // Then: both destinations are real unborn repositories with the captured bytes.
      expect(pair.baselineHead).toBeNull();
      expect(pair.candidates).toHaveLength(2);
      for (const candidate of pair.candidates) {
        expect(gitResult(candidate.workspacePath, ["rev-parse", "--show-toplevel"]).exitCode).toBe(0);
        expect(gitResult(candidate.workspacePath, ["rev-parse", "HEAD"]).exitCode).not.toBe(0);
        expect(await readFile(join(candidate.workspacePath, "draft.txt"), "utf8")).toBe("first draft\n");
      }
      expect(gitResult(repository, ["rev-parse", "HEAD"]).exitCode).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expires only an unpinned clean loser while preserving winners and other terminal candidates", async () => {
    // Given: expired pairs covering each cleanup safety decision.
    const fixture = await fixtureRepository("cleanup");
    let now = 100;
    try {
      const store = await RepositorySnapshotStore.open(join(fixture.root, "data"));
      const snapshot = await store.capture(fixture.repository);
      const managerRoot = join(fixture.root, "manager");
      const manager = await CandidateWorktreeManager.open(managerRoot, {
        clock: () => now,
        ttlMs: 10,
      });
      const activePair = await createPair(manager, store, snapshot, fixture.repository, "active-pair");
      const unsafePair = await createPair(manager, store, snapshot, fixture.repository, "unsafe-pair");
      const winnerPair = await createPair(manager, store, snapshot, fixture.repository, "winner-pair");
      const releasedPair = await createPair(manager, store, snapshot, fixture.repository, "released-pair");
      await manager.setStatus("active-pair", 1, status("abandoned"));
      await manager.setStatus("unsafe-pair", 0, status("loser"));
      await manager.setStatus("unsafe-pair", 1, status("loser"));
      await manager.setStatus("winner-pair", 0, winner(false));
      await manager.setStatus("winner-pair", 1, winner(true));
      await manager.setStatus("released-pair", 0, winner(true));
      await manager.setStatus("released-pair", 1, status("loser"));
      await manager.setPinned("unsafe-pair", 0, false);
      await manager.setPinned("unsafe-pair", 1, false);
      await manager.setPinned("released-pair", 1, false);
      await writeFile(join(unsafePair.candidates[0].workspacePath, "tracked.txt"), "dirty candidate\n");
      const externalWorktree = join(fixture.root, "external-worktree");
      git(fixture.repository, ["worktree", "add", "--detach", externalWorktree, "HEAD"]);
      const unsafeManifest = join(managerRoot, "manifests", "unsafe-pair.json");
      const encoded = await readFile(unsafeManifest, "utf8");
      await writeFile(unsafeManifest, encoded.replace(
        JSON.stringify(unsafePair.candidates[1].workspacePath),
        JSON.stringify(externalWorktree),
      ));
      now = 111;

      // When: expired candidates are collected.
      const result = await manager.cleanupExpired();

      // Then: only the selected unpinned loser is removed; unsafe losers and every winner survive.
      expect(result.removed.map((item) => `${item.requestId}:${item.candidateIndex}`)).toEqual([
        "released-pair:1",
      ]);
      expect(result.diagnostics).toEqual([
        { requestId: "active-pair", candidateIndex: 0, kind: "active" },
        { requestId: "active-pair", candidateIndex: 1, kind: "not-loser" },
        { requestId: "released-pair", candidateIndex: 0, kind: "winner" },
        { requestId: "unsafe-pair", candidateIndex: 0, kind: "dirty" },
        { requestId: "unsafe-pair", candidateIndex: 1, kind: "unregistered" },
        { requestId: "winner-pair", candidateIndex: 0, kind: "winner" },
        { requestId: "winner-pair", candidateIndex: 1, kind: "winner" },
      ]);
      expect(await directoryExists(activePair.candidates[0].workspacePath)).toBe(true);
      expect(await directoryExists(activePair.candidates[1].workspacePath)).toBe(true);
      expect(await directoryExists(unsafePair.candidates[0].workspacePath)).toBe(true);
      expect(await directoryExists(unsafePair.candidates[1].workspacePath)).toBe(true);
      expect(await directoryExists(externalWorktree)).toBe(true);
      expect(await directoryExists(winnerPair.candidates[0].workspacePath)).toBe(true);
      expect(await directoryExists(winnerPair.candidates[1].workspacePath)).toBe(true);
      expect(await directoryExists(releasedPair.candidates[0].workspacePath)).toBe(true);
      expect(await directoryExists(releasedPair.candidates[1].workspacePath)).toBe(false);
      expect(result.releaseOwnerIds).toEqual(["released-pair-1"]);
      expect((await manager.getPair("released-pair"))?.candidates[0].pinned).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("preserves a terminal candidate until its renewed lease expires", async () => {
    // Given: a completed candidate whose lease is renewed.
    const fixture = await fixtureRepository("lease");
    let now = 1_000;
    try {
      const store = await RepositorySnapshotStore.open(join(fixture.root, "data"));
      const snapshot = await store.capture(fixture.repository);
      const manager = await CandidateWorktreeManager.open(join(fixture.root, "manager"), {
        clock: () => now,
        ttlMs: 50,
      });
      const pair = await createPair(manager, store, snapshot, fixture.repository, "lease-pair");
      await manager.setStatus("lease-pair", 0, status("loser"));
      await manager.setPinned("lease-pair", 0, false);
      now = 1_040;
      await manager.renewLease("lease-pair", 0);
      now = 1_060;

      // When: cleanup runs after the original lease but before the renewed lease.
      const result = await manager.cleanupExpired();

      // Then: the candidate remains protected by a typed lease diagnostic.
      expect(result.removed).toEqual([]);
      expect(result.diagnostics).toContainEqual({
        requestId: "lease-pair",
        candidateIndex: 0,
        kind: "lease-valid",
      });
      expect(await directoryExists(pair.candidates[0].workspacePath)).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

type Snapshot = Awaited<ReturnType<RepositorySnapshotStore["capture"]>>;

async function createPair(
  manager: CandidateWorktreeManager,
  store: RepositorySnapshotStore,
  snapshot: Snapshot,
  sourceCwd: string,
  requestId: string,
) {
  return manager.createPair({
    requestId,
    sourceCwd,
    sourceThreadId: "source-thread",
    checkpointId: `checkpoint-${requestId}`,
    retentionOwnerIds: [`${requestId}-0`, `${requestId}-1`],
    snapshot,
    snapshotStore: store,
  });
}

function status(kind: "completed" | "loser" | "abandoned"): CandidateLifecycleStatus {
  return { protocolVersion: 1, kind };
}

function winner(finalized: boolean): CandidateLifecycleStatus {
  return { protocolVersion: 1, kind: "winner", finalized };
}

async function fixtureRepository(name: string): Promise<Readonly<{ root: string; repository: string }>> {
  const root = await mkdtemp(join(tmpdir(), `pi-candidates-${name}-`));
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

function git(cwd: string, args: readonly string[]): string {
  const result = gitResult(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function gitResult(cwd: string, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

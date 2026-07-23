import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { CandidatePromotion } from "../src/repository/candidate-promotion.ts";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import {
  BacktrackCoordinator,
  type CandidateRunner,
  type CoordinatorDurableStage,
} from "../src/workflow/backtrack-coordinator.ts";
import type { CandidateTieCritic } from "../src/workflow/candidate-scoring.ts";
import { CandidateWorktreeManager } from "../src/workspace/candidate-worktree-manager.ts";

describe("BacktrackCoordinator", () => {
  test("runs exactly two and resumes without repeating candidates or promotion", async () => {
    // Given: an accepted checkpoint and a crash after both concurrent candidates are durable.
    const fixture = await coordinatorFixture("resume");
    const starts: number[] = [];
    let active = 0;
    let overlap = false;
    const runner = runnerFor(fixture.repository, starts, (count) => {
      active += count;
      overlap ||= active === 2;
    });
    try {
      const crashing = await fixture.coordinator(runner, async (stage) => {
        if (stage === "candidates-completed") throw new InjectedCrash();
      });

      // When: the durable coordinator is reopened and invoked twice.
      await expect(crashing.run(fixture.input)).rejects.toBeInstanceOf(InjectedCrash);
      const restarted = await fixture.coordinator(runner);
      const outcome = await restarted.run(fixture.input);
      const repeated = await restarted.run(fixture.input);

      // Then: exactly two overlapping variants ran, one deterministic winner was promoted once, and HEAD did not move.
      expect(starts.sort()).toEqual([0, 1]);
      expect(overlap).toBe(true);
      expect(outcome).toEqual(repeated);
      expect(outcome).toMatchObject({ kind: "promoted", winnerCandidateIndex: 0 });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("winner\n");
      expect(git(fixture.repository, ["rev-parse", "HEAD"])).toBe(fixture.head);
      expect((await fixture.promotion.getRecord(fixture.requestId))?.state).toBe("promoted");
      const pair = await fixture.manager.getPair(fixture.requestId);
      expect(pair?.candidates.map((candidate) => candidate.status)).toEqual([
        { protocolVersion: 1, kind: "winner", finalized: true },
        { protocolVersion: 1, kind: "loser" },
      ]);
      expect(pair?.candidates.map((candidate) => candidate.pinned)).toEqual([true, false]);
      expect((await fixture.checkpoints.listThreads()).map((threadId) => threadId.replace(
        /^backtrack-[a-f0-9]{32}/,
        "backtrack",
      ))).toEqual(["backtrack-candidate-0", "backtrack-candidate-1", "source-thread"]);
    } finally {
      await fixture.close();
    }
  });

  test("blocks when effects are unsafe and retains both evidence receipts", async () => {
    // Given: two completed candidates whose external effects are not fully known.
    const fixture = await coordinatorFixture("unsafe");
    const starts: number[] = [];
    const runner = runnerFor(fixture.repository, starts, () => undefined, false);
    try {
      const coordinator = await fixture.coordinator(runner);

      // When: the coordinator scores the ineligible pair and is restarted.
      const before = await fixture.store.capture(fixture.repository);
      const outcome = await coordinator.run(fixture.input);
      const repeated = await (await fixture.coordinator(runner)).run(fixture.input);

      // Then: promotion is blocked, source identity is unchanged, and durable evidence prevents reruns.
      expect(outcome).toEqual(repeated);
      expect(outcome).toMatchObject({ kind: "needs_attention", reason: "no_eligible_candidate" });
      expect(outcome.candidateReceipts.map((receipt) => receipt?.evidence.receiptId)).toEqual([
        "evidence-0",
        "evidence-1",
      ]);
      expect(starts.sort()).toEqual([0, 1]);
      expect(await fixture.store.capture(fixture.repository)).toEqual(before);
      expect(await fixture.promotion.getRecord(fixture.requestId)).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  test("resumes every durable create, clone, score, promote, and cleanup boundary", async () => {
    // Given: each coordinator boundary fails once immediately after its durable write.
    const stages = [
      "candidates-created",
      "checkpoints-cloned",
      "scored",
      "promoted",
      "cleanup-attempted",
    ] as const;
    for (const stage of stages) {
      const fixture = await coordinatorFixture(`boundary-${stage}`);
      const starts: number[] = [];
      const runner = runnerFor(fixture.repository, starts, () => undefined);
      try {
        const crashing = await fixture.coordinator(runner, async (current) => {
          if (current === stage) throw new InjectedCrash();
        });

        // When: the same request is resumed from the persisted boundary.
        await expect(crashing.run(fixture.input)).rejects.toBeInstanceOf(InjectedCrash);
        const outcome = await (await fixture.coordinator(runner)).run(fixture.input);

        // Then: it reaches the same deterministic terminal without extra candidates or promotion.
        expect(outcome).toMatchObject({ kind: "promoted", winnerCandidateIndex: 0 });
        expect(starts.sort()).toEqual([0, 1]);
        expect((await fixture.promotion.getRecord(fixture.requestId))?.state).toBe("promoted");
      } finally {
        await fixture.close();
      }
    }
  });

  test("calls a bounded critic only for a true dimensional tie and persists its decision", async () => {
    // Given: exactly tied candidate score dimensions and a critic selecting the alternate candidate.
    const fixture = await coordinatorFixture("critic-tie");
    let criticCalls = 0;
    const critic: CandidateTieCritic = async () => {
      criticCalls += 1;
      return { protocolVersion: 1, winnerCandidateIndex: 1 };
    };
    try {
      const coordinator = await fixture.coordinator(runnerFor(fixture.repository, [], () => undefined, true, true), undefined, critic);

      // When: the coordinator reaches its deterministic scoring boundary.
      const outcome = await coordinator.run(fixture.input);

      // Then: only the supplied candidate index can win and its validated decision is durable.
      expect(criticCalls).toBe(1);
      expect(outcome).toMatchObject({ kind: "promoted", winnerCandidateIndex: 1 });
      expect(await readFile(join(fixture.root, "coordinator", "records", `${fixture.requestId}.json`), "utf8"))
        .toContain('"tieDecision":{"protocolVersion":1,"winnerCandidateIndex":1}');
    } finally {
      await fixture.close();
    }
  });
});

class InjectedCrash extends Error {}

type Fixture = Readonly<{
  root: string;
  repository: string;
  requestId: string;
  head: string;
  checkpoints: FileCheckpointSaver;
  store: RepositorySnapshotStore;
  manager: CandidateWorktreeManager;
  promotion: CandidatePromotion;
  input: Readonly<{
    preflight: Readonly<{
      kind: "accepted";
      requestId: string;
      threadId: string;
      checkpointId: string;
      targetCheckpointSnapshotId: string;
      sourceSnapshotIdAtAcceptance: string;
    }>;
    sourceDirectory: string;
  }>;
  coordinator: (
    runner: CandidateRunner,
    onDurableStage?: (stage: CoordinatorDurableStage) => Promise<void>,
    tieCritic?: CandidateTieCritic,
  ) => Promise<BacktrackCoordinator>;
  close: () => Promise<void>;
}>;

async function coordinatorFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-backtrack-coordinator-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "tracked.txt"), "base\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const head = git(repository, ["rev-parse", "HEAD"]);
  const checkpoints = await FileCheckpointSaver.open(join(root, "checkpoints"));
  const store = await RepositorySnapshotStore.open(join(root, "data"));
  const snapshot = await store.capture(repository);
  const metadata: CheckpointMetadata = { source: "loop", step: 0, parents: {} };
  await checkpoints.put(
    { configurable: { thread_id: "source-thread" } },
    checkpoint("selected-checkpoint"),
    metadata,
    {},
  );
  const manager = await CandidateWorktreeManager.open(join(root, "candidates"));
  const promotion = await CandidatePromotion.open(join(root, "promotion"), manager, store);
  const requestId = `request-${name}`;
  const input = {
    preflight: {
      kind: "accepted",
      requestId,
      threadId: "source-thread",
      checkpointId: "selected-checkpoint",
      targetCheckpointSnapshotId: snapshot.snapshotId,
      sourceSnapshotIdAtAcceptance: snapshot.snapshotId,
    },
    sourceDirectory: repository,
  } as const;
  return {
    root,
    repository,
    requestId,
    head,
    checkpoints,
    store,
    manager,
    promotion,
    input,
    coordinator: (runner, onDurableStage, tieCritic) => BacktrackCoordinator.open(join(root, "coordinator"), {
      checkpoints,
      snapshotStore: store,
      candidateManager: manager,
      promotion,
      runner,
      ...(tieCritic === undefined ? {} : { tieCritic }),
      ...(onDurableStage === undefined ? {} : { onDurableStage }),
    }),
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function runnerFor(
  source: string,
  starts: number[],
  active: (change: number) => void,
  effectsSafe = true,
  tie = false,
): CandidateRunner {
  let release: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (candidateIndex, _threadId, workspacePath, variant) => {
    starts.push(candidateIndex);
    active(1);
    if (starts.length === 2) release?.();
    await bothStarted;
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("base\n");
    const content = tie ? (candidateIndex === 0 ? "tie-0\n" : "tie-1\n") : variant === "minimal-change" ? "winner\n" : "alternate\n";
    await writeFile(join(workspacePath, "tracked.txt"), content);
    active(-1);
    return {
      score: {
        replayCompatible: true,
        deliveryCompleted: true,
        hostVerification: { passed: true },
        unresolvedRisks: [],
        changedPaths: ["tracked.txt"],
        changedBytes: Buffer.byteLength(content),
      },
      effects: { fullyKnown: effectsSafe, fullyCompensable: effectsSafe },
      evidence: { protocolVersion: 1, receiptId: `evidence-${candidateIndex}`, artifactRefs: [] },
    };
  };
}

function checkpoint(id: string): Checkpoint {
  return { v: 4, id, ts: new Date(0).toISOString(), channel_values: {}, channel_versions: {}, versions_seen: {} };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CandidatePromotion,
  CandidatePromotionError,
  type CandidatePromotionScore,
} from "../src/repository/candidate-promotion.ts";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import { CandidateWorktreeManager } from "../src/workspace/candidate-worktree-manager.ts";
import type { CandidateScoreReceipt } from "../src/workflow/candidate-scoring.ts";

describe("CandidatePromotion", () => {
  test("promotes exactly once while preserving a dirty baseline", async () => {
    // Given: a scored winner based on an exact dirty source snapshot.
    const fixture = await promotionFixture("once");
    try {
      await writeFile(join(fixture.winner, "tracked.txt"), "winner\n");
      await writeFile(join(fixture.winner, "added.txt"), "added\n");
      await fixture.promotion.recordScored(score("request-once", fixture.snapshotId, ["added.txt", "tracked.txt"], 13));
      const head = git(fixture.repository, ["rev-parse", "HEAD"]);

      // When: two promoters contend for the same durable request.
      const attempts = await Promise.allSettled([
        fixture.promotion.promote("request-once"),
        fixture.promotion.promote("request-once"),
      ]);

      // Then: one terminal receipt wins and unrelated dirty source bytes survive.
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejection = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejection?.status === "rejected" && rejection.reason instanceof CandidatePromotionError
        ? rejection.reason.code : undefined).toBe("already_promoted");
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("winner\n");
      expect(await readFile(join(fixture.repository, "added.txt"), "utf8")).toBe("added\n");
      expect(await readFile(join(fixture.repository, "unrelated.txt"), "utf8")).toBe("preserve me\n");
      expect(git(fixture.repository, ["rev-parse", "HEAD"])).toBe(head);
      const terminal = await fixture.promotion.getRecord("request-once");
      expect(terminal?.state).toBe("promoted");
      expect(terminal?.state === "promoted" ? terminal.finalSnapshotId : undefined)
        .toBe((await fixture.store.capture(fixture.repository)).snapshotId);
    } finally {
      await fixture.close();
    }
  });

  test("rejects source race without overwriting the concurrent edit", async () => {
    // Given: a scored winner followed by a user edit in the source.
    const fixture = await promotionFixture("race");
    try {
      await writeFile(join(fixture.winner, "tracked.txt"), "winner\n");
      await fixture.promotion.recordScored(score("request-race", fixture.snapshotId, ["tracked.txt"], 7));
      await writeFile(join(fixture.repository, "unrelated.txt"), "concurrent user edit\n");

      // When: promotion checks its source compare-and-set.
      const action = fixture.promotion.promote("request-race");

      // Then: the typed race is rejected and the request remains non-promoted.
      await expect(action).rejects.toMatchObject({ code: "source_changed" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("dirty baseline\n");
      expect(await readFile(join(fixture.repository, "unrelated.txt"), "utf8")).toBe("concurrent user edit\n");
      expect((await fixture.promotion.getRecord("request-race"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });

  test("rejects a same-path edit immediately before replacement without overwriting it", async () => {
    // Given: a scored winner and a user write injected at the selected path during publication.
    let repository = "";
    const fixture = await promotionFixture("same-path-race", async (path) => {
      if (path === "tracked.txt") {
        await writeFile(join(repository, path), "concurrent same-path user edit\n");
      }
    });
    repository = fixture.repository;
    try {
      await writeFile(join(fixture.winner, "tracked.txt"), "winner\n");
      await fixture.promotion.recordScored(
        score("request-same-path-race", fixture.snapshotId, ["tracked.txt"], 7),
      );

      // When: promotion reaches the immediate replacement window.
      const action = fixture.promotion.promote("request-same-path-race");

      // Then: the typed race is rejected and the user's same-path bytes remain authoritative.
      await expect(action).rejects.toMatchObject({ code: "source_changed" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8"))
        .toBe("concurrent same-path user edit\n");
      expect((await fixture.promotion.getRecord("request-same-path-race"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });

  test("rejects an unsafe candidate file before source mutation", async () => {
    // Given: a winner containing an untracked symlink.
    const fixture = await promotionFixture("unsafe");
    try {
      await symlink("/etc/passwd", join(fixture.winner, "escape"));
      await fixture.promotion.recordScored(score("request-unsafe", fixture.snapshotId, ["escape"], 0));

      // When: promotion validates the candidate delta.
      const action = fixture.promotion.promote("request-unsafe");

      // Then: unsafe input is typed and source bytes remain unchanged.
      await expect(action).rejects.toMatchObject({ code: "unsafe_candidate" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("dirty baseline\n");
      expect((await fixture.promotion.getRecord("request-unsafe"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });

  test("rolls back an owned file when publication fails mid-delta", async () => {
    // Given: two winner files and a deterministic failure before the second publication.
    const fixture = await promotionFixture("rollback", async (_path, index) => {
      if (index === 1) throw new Error("injected publication failure");
    });
    try {
      await writeFile(join(fixture.winner, "tracked.txt"), "winner\n");
      await writeFile(join(fixture.winner, "z-added.txt"), "added\n");
      await fixture.promotion.recordScored(score("request-rollback", fixture.snapshotId, ["tracked.txt", "z-added.txt"], 13));

      // When: publication fails after its first owned path.
      const action = fixture.promotion.promote("request-rollback");

      // Then: the transaction restores the full source baseline.
      await expect(action).rejects.toMatchObject({ code: "publish_failed" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("dirty baseline\n");
      await expect(readFile(join(fixture.repository, "z-added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fixture.promotion.getRecord("request-rollback"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });

  test("blocks an effect-unsafe winner without source mutation", async () => {
    // Given: a durable score whose effects are unknown.
    const fixture = await promotionFixture("blocked");
    try {
      const unsafe = score("request-blocked", fixture.snapshotId, [], 0, false);
      await fixture.promotion.recordScored(unsafe);

      // When: the unsafe score is presented for promotion.
      const action = fixture.promotion.promote("request-blocked");

      // Then: eligibility is enforced and no source path changes.
      await expect(action).rejects.toMatchObject({ code: "unsafe_effects" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("dirty baseline\n");
      expect((await fixture.promotion.getRecord("request-blocked"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });

  test("blocks an ineligible deterministic winner without source mutation", async () => {
    // Given: a durable score with safe effects but no eligible candidate.
    const fixture = await promotionFixture("ineligible");
    try {
      await fixture.promotion.recordScored(score("request-ineligible", fixture.snapshotId, [], 0, true, false));

      // When: the ineligible score is presented for promotion.
      const action = fixture.promotion.promote("request-ineligible");

      // Then: receipt eligibility is enforced before any source path changes.
      await expect(action).rejects.toMatchObject({ code: "invalid_receipt" });
      expect(await readFile(join(fixture.repository, "tracked.txt"), "utf8")).toBe("dirty baseline\n");
      expect((await fixture.promotion.getRecord("request-ineligible"))?.state).toBe("scored");
    } finally {
      await fixture.close();
    }
  });
});

type Fixture = Readonly<{
  root: string;
  repository: string;
  winner: string;
  snapshotId: string;
  store: RepositorySnapshotStore;
  promotion: CandidatePromotion;
  close: () => Promise<void>;
}>;

async function promotionFixture(
  name: string,
  beforePublishPath?: (path: string, index: number) => Promise<void>,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-promotion-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "tracked.txt"), "committed\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  await writeFile(join(repository, "tracked.txt"), "dirty baseline\n");
  await writeFile(join(repository, "unrelated.txt"), "preserve me\n");
  const store = await RepositorySnapshotStore.open(join(root, "data"));
  const snapshot = await store.capture(repository);
  const manager = await CandidateWorktreeManager.open(join(root, "manager"));
  const requestId = `request-${name}`;
  const pair = await manager.createPair({
    requestId,
    sourceCwd: repository,
    sourceThreadId: "source-thread",
    checkpointId: `checkpoint-${name}`,
    retentionOwnerIds: [`${requestId}-0`, `${requestId}-1`],
    snapshot,
    snapshotStore: store,
  });
  await manager.setStatus(requestId, 0, { protocolVersion: 1, kind: "winner", finalized: false });
  await manager.setStatus(requestId, 1, { protocolVersion: 1, kind: "loser" });
  const options = beforePublishPath === undefined ? {} : { beforePublishPath };
  const promotion = await CandidatePromotion.open(join(root, "promotion"), manager, store, options);
  return {
    root,
    repository,
    winner: pair.candidates[0].workspacePath,
    snapshotId: snapshot.snapshotId,
    store,
    promotion,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function score(
  requestId: string,
  expectedSnapshotId: string,
  changedPaths: readonly string[],
  changedBytes: number,
  safe = true,
  eligible = safe,
): CandidatePromotionScore {
  const receipt = (candidateIndex: 0 | 1): CandidateScoreReceipt => ({
    candidateIndex,
    eligible,
    ineligibilityReasons: eligible ? [] : ["unknown-effects"],
    failedHostChecks: 0,
    unresolvedRiskCount: 0,
    changedPathCount: candidateIndex === 0 ? changedPaths.length : 0,
    changedByteCount: candidateIndex === 0 ? changedBytes : 0,
    changedPaths: candidateIndex === 0 ? changedPaths : [],
    score: [candidateIndex],
  });
  return {
    protocolVersion: 1,
    requestId,
    expectedSnapshotId,
    winnerCandidateIndex: 0,
    scoreReceipts: [receipt(0), receipt(1)],
    effects: { fullyKnown: safe, fullyCompensable: safe },
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

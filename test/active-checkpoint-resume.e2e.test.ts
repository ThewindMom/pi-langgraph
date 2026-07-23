import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createPausedResumeFixture } from "./active-checkpoint-resume-fixture.ts";

test("explicit resume rejects an older active checkpoint before worker or repository mutation", async () => {
  // Given: a paused workflow whose Pi tree selects an older semantic checkpoint.
  const fixture = await createPausedResumeFixture("older");
  const sourceBefore = await readFile(join(fixture.repository, "feature.ts"), "utf8");
  const siblingBefore = await readFile(join(fixture.repository, "sibling.ts"), "utf8");
  fixture.select(fixture.older);
  fixture.resetWorkerStarts();

  try {
    // When: explicit resume is requested for the selected thread.
    const action = fixture.dispatcher({
      input: { resumeThreadId: fixture.threadId },
      context: fixture.context,
    });

    // Then: the runtime requires an explicit fork and leaves both source and sibling untouched.
    await expect(action).rejects.toMatchObject({
      name: "ReplayResumeRejectedError",
      reason: "active-checkpoint-requires-fork",
    });
    expect(fixture.workerStarts()).toBe(0);
    expect(await readFile(join(fixture.repository, "feature.ts"), "utf8")).toBe(sourceBefore);
    expect(await readFile(join(fixture.repository, "sibling.ts"), "utf8")).toBe(siblingBefore);
  } finally {
    await fixture.close();
  }
});

test("explicit resume accepts the active latest checkpoint", async () => {
  // Given: a paused workflow whose Pi tree selects the latest resumable checkpoint.
  const fixture = await createPausedResumeFixture("latest");
  fixture.select(fixture.latest);
  fixture.resetWorkerStarts();

  try {
    // When: the exact interrupt decision is resumed through the selected latest binding.
    const result = await fixture.dispatcher({
      input: {
        resumeThreadId: fixture.threadId,
        decision: fixture.decision,
      },
      context: fixture.context,
    });

    // Then: the selected lineage runs and completes through real dispatcher workers.
    expect(result.details).toMatchObject({ status: "completed", threadId: fixture.threadId });
    expect(fixture.workerStarts()).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test("explicit resume rejects a mismatched managed worktree binding", async () => {
  // Given: a latest checkpoint link bound to a different managed worktree.
  const fixture = await createPausedResumeFixture("worktree-mismatch");
  fixture.select({
    ...fixture.latest,
    link: {
      ...fixture.latest.link,
      managedWorktree: {
        protocolVersion: 1,
        kind: "candidate",
        candidateIndex: 0,
        worktreeId: "different-worktree",
        path: join(fixture.repository, "different-worktree"),
      },
    },
  });
  fixture.resetWorkerStarts();

  try {
    // When: explicit resume supplies the valid pending decision.
    const action = fixture.dispatcher({
      input: { resumeThreadId: fixture.threadId, decision: fixture.decision },
      context: fixture.context,
    });

    // Then: the managed-worktree mismatch fails closed before worker execution.
    await expect(action).rejects.toMatchObject({
      name: "ReplayResumeRejectedError",
      reason: "active-worktree-mismatch",
    });
    expect(fixture.workerStarts()).toBe(0);
  } finally {
    await fixture.close();
  }
});

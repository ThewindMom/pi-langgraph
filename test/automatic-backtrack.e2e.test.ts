import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { RepositorySnapshotStore } from "../src/repository/repository-snapshot-store.ts";
import { runAutomaticBacktrack } from "../src/runtime/automatic-backtrack.ts";
import { bindNewWorkflowReplay } from "../src/runtime/replay-context.ts";
import { REPOSITORY_ONLY_EFFECT_LEDGER } from "../src/runtime/task-execution-effects.ts";
import type { CandidateRunner } from "../src/workflow/backtrack-coordinator.ts";
import type { CodingWorkflowResult } from "../src/workflow/types.ts";

describe("automatic structured backtracking", () => {
  test("runs exactly two candidates from a pre-mutation checkpoint after a failed mutation", async () => {
    // Given: a replay-bound pre-mutation checkpoint and a failed, repository-local mutation.
    const root = await mkdtemp(join(tmpdir(), "pi-automatic-backtrack-"));
    const repository = join(root, "repository");
    const dataRoot = join(root, "data");
    await mkdir(repository);
    await writeFile(join(repository, "tracked.txt"), "baseline\n");
    await writeFile(join(repository, "unrelated.txt"), "keep-current-edit\n");
    git(repository, ["init"]);
    git(repository, ["config", "user.name", "Pi LangGraph Test"]);
    git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "fixture"]);
    const checkpoints = await FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
    const snapshots = await RepositorySnapshotStore.open(dataRoot);
    const policy = {
      adapter: "native",
      inheritedModel: null,
      activeTools: ["task"],
      protocol: "pi-langgraph.worker.v1",
    } as const;
    await bindNewWorkflowReplay({
      checkpoints,
      snapshotStore: snapshots,
      threadId: "failed-thread",
      sourceDirectory: repository,
      workflowInput: { objective: "repair tracked output", workflow: "delivery", maxIterations: 1 },
      policy,
      effectLedger: REPOSITORY_ONLY_EFFECT_LEDGER,
    });
    await checkpoints.put(
      { configurable: { thread_id: "failed-thread" } },
      checkpoint("pre-mutation", analyzedState()),
      metadata,
      {},
    );
    await writeFile(join(repository, "tracked.txt"), "failed-mutation\n");
    const starts: number[] = [];
    const runner: CandidateRunner = async (candidateIndex, _threadId, workspacePath, variant) => {
      starts.push(candidateIndex);
      const content = variant === "minimal-change" ? "winner\n" : "alternate approach\n";
      await writeFile(join(workspacePath, "tracked.txt"), content);
      return {
        score: {
          replayCompatible: true,
          deliveryCompleted: true,
          hostVerification: { passed: true },
          unresolvedRisks: [],
          changedPaths: ["tracked.txt"],
          changedBytes: Buffer.byteLength(content),
        },
        effects: { fullyKnown: true, fullyCompensable: true },
        evidence: { protocolVersion: 1, receiptId: `receipt-${candidateIndex}`, artifactRefs: [] },
      };
    };

    try {
      // When: the exhausted structured failure enters the final best-of-two recovery budget.
      const outcome = await runAutomaticBacktrack({
        dataRoot,
        checkpoints,
        snapshotStore: snapshots,
        sourceDirectory: repository,
        result: failedResult(),
        effectLedger: REPOSITORY_ONLY_EFFECT_LEDGER,
        runner,
      });

      // Then: both fixed variants run, the deterministic winner is promoted over the current failed tree,
      // and an unrelated current edit remains intact.
      expect(starts.sort()).toEqual([0, 1]);
      expect(outcome).toMatchObject({ kind: "promoted", winnerCandidateIndex: 0 });
      expect(await readFile(join(repository, "tracked.txt"), "utf8")).toBe("winner\n");
      expect(await readFile(join(repository, "unrelated.txt"), "utf8")).toBe("keep-current-edit\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not auto-backtrack review, approval, or unsafe-effect outcomes", async () => {
    // Given: terminal inputs which are not eligible for autonomous mutation recovery.
    const root = await mkdtemp(join(tmpdir(), "pi-automatic-backtrack-blocked-"));
    const checkpoints = await FileCheckpointSaver.open(join(root, "checkpoints"));
    const snapshots = await RepositorySnapshotStore.open(root);
    const starts: number[] = [];
    const runner: CandidateRunner = async () => {
      starts.push(1);
      throw new Error("runner must not execute");
    };
    try {
      // When: policy gating runs before candidate creation.
      const review = await runAutomaticBacktrack({
        dataRoot: root,
        checkpoints,
        snapshotStore: snapshots,
        sourceDirectory: root,
        result: { ...failedResult(), pattern: "review" },
        effectLedger: REPOSITORY_ONLY_EFFECT_LEDGER,
        runner,
      });
      const unsafe = await runAutomaticBacktrack({
        dataRoot: root,
        checkpoints,
        snapshotStore: snapshots,
        sourceDirectory: root,
        result: failedResult(),
        effectLedger: { protocolVersion: 1, effects: [{ kind: "unknown", effectId: "opaque-tool" }] },
        runner,
      });

      // Then: both remain clear needs-attention outcomes and no candidate starts.
      expect(review).toEqual({ kind: "needs_attention", reason: "review-objective" });
      expect(unsafe).toEqual({ kind: "needs_attention", reason: "unsafe-effects" });
      expect(starts).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const metadata: CheckpointMetadata = { source: "loop", step: 1, parents: {} };

function checkpoint(id: string, channelValues: Readonly<Record<string, unknown>>): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: channelValues,
    channel_versions: {},
    versions_seen: {},
  };
}

function analyzedState(): Readonly<Record<string, unknown>> {
  return {
    objective: "repair tracked output",
    pattern: "delivery",
    maxIterations: 1,
    approvalRequired: false,
    discoveryRound: 1,
    workItems: [{ id: "repair", title: "Repair", instruction: "Repair tracked output" }],
    acceptanceCriteria: ["tests pass"],
    findings: [],
    changes: [],
    iteration: 0,
    phase: "analyzed",
    status: "running",
    summary: "",
    unresolvedRisks: [],
    trace: [],
    changeResults: [],
    evidenceRefs: [],
  };
}

function failedResult(): CodingWorkflowResult {
  const verification = {
    passed: false,
    summary: "tests still fail",
    checks: [{ name: "package:test", passed: false, evidence: "exit 1" }],
  } as const;
  return {
    threadId: "failed-thread",
    objective: "repair tracked output",
    pattern: "delivery",
    status: "needs_attention",
    phase: "escalated",
    workItems: [{ id: "repair", title: "Repair", instruction: "Repair tracked output" }],
    findings: [],
    changes: [{
      kind: "implementation",
      summary: "attempted repair",
      filesChanged: ["tracked.txt"],
      evidence: [],
      unresolvedRisks: [],
    }],
    verification,
    unresolvedRisks: [],
    iteration: 1,
    summary: "repair budget exhausted",
    trace: [
      { node: "implement", iteration: 0 },
      { node: "verify", iteration: 0, route: "diagnose" },
      { node: "diagnose", iteration: 0, route: "implement" },
      { node: "repair", iteration: 1 },
      { node: "verify", iteration: 1, route: "escalate" },
      { node: "escalate", iteration: 1 },
    ],
    changeResults: [{
      changeId: "repair",
      status: "needs_attention",
      attempt: 1,
      evidenceRefs: [],
      verification,
    }],
    evidenceRefs: [],
  };
}

function git(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

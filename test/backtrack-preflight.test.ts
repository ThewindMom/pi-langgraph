import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBacktrackRequest } from "../src/bridge/codec.ts";
import type { BacktrackRequestV1 } from "../src/bridge/types.ts";
import { checkpointReplayMetadata } from "../src/persistence/checkpoint-thread-codec.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { createRepositorySnapshot } from "../src/repository/snapshot.ts";
import { effectLedgerDigest, type EffectLedger } from "../src/workflow/effect-ledger.ts";
import { preflightBacktrack, type BacktrackPreflightResult } from "../src/workflow/backtrack.ts";

const modelDigest = "b".repeat(64);
const SAFE_LEDGER: EffectLedger = { protocolVersion: 1, effects: [] };
const UNSAFE_LEDGER: EffectLedger = { protocolVersion: 1, effects: [{ kind: "unknown", effectId: "unknown-1" }] };

test("accepts exact safe checkpoint without creating candidates", async () => {
  // Given: a replay-bound exact checkpoint and an unchanged source snapshot.
  const fixture = await createFixture();
  try {
    const before = await sourceProof(fixture);

    // When: the typed request preflights its exact linked checkpoint.
    const result = await preflightBacktrack(fixture.request, fixture.input());

    // Then: only the deterministic two candidate identities are returned.
    expect(result).toMatchObject({
      kind: "accepted", checkpointId: "checkpoint-01", threadId: "thread-01",
      targetCheckpointSnapshotId: fixture.request.link.repositorySnapshot.snapshotId,
      sourceSnapshotIdAtAcceptance: fixture.request.link.repositorySnapshot.snapshotId,
      replayFingerprint: fixture.request.link.replayFingerprint,
      candidateIds: ["candidate-0", "candidate-1"],
    });
    expect(await sourceProof(fixture)).toEqual(before);
  } finally { await fixture.dispose(); }
});

test("rejects unsafe replay inputs without side effects", async () => {
  // Given: a safe exact fixture and independent invalid preflight inputs.
  const cases: readonly RejectionCase[] = [
    { expected: "incompatible", request: (fixture) => ({ ...fixture.request, link: { ...fixture.request.link, replayFingerprint: "d".repeat(64) } }), fixtureLedger: SAFE_LEDGER, ledger: SAFE_LEDGER },
    { expected: "blocked_effect", request: (fixture) => fixture.request, fixtureLedger: UNSAFE_LEDGER, ledger: UNSAFE_LEDGER },
    { expected: "source_changed", request: (fixture) => fixture.request, fixtureLedger: SAFE_LEDGER, ledger: SAFE_LEDGER, moveHead: true },
    { expected: "missing_checkpoint", request: (fixture) => ({ ...fixture.request, link: { ...fixture.request.link, checkpointId: "missing-01" } }), fixtureLedger: SAFE_LEDGER, ledger: SAFE_LEDGER },
    { expected: "already_terminal", request: (fixture) => fixture.request, fixtureLedger: SAFE_LEDGER, ledger: SAFE_LEDGER, terminal: true },
  ];
  for (const item of cases) {
    const fixture = await createFixture(item.fixtureLedger, item.terminal === true);
    try {
      if (item.moveHead === true) {
        await writeFile(join(fixture.source, "tracked.txt"), "changed\n");
        runGit(fixture.source, ["add", "tracked.txt"]);
        runGit(fixture.source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "source moved"]);
      }
      const before = await sourceProof(fixture);

      // When: the invalid typed request is preflighted.
      const result = await preflightBacktrack(item.request(fixture), fixture.input(item.ledger));

      // Then: its typed rejection leaves source and candidate/promotion directories untouched.
      expect(result.kind).toBe(item.expected);
      expect(await sourceProof(fixture)).toEqual(before);
    } finally { await fixture.dispose(); }
  }
});

type Fixture = Readonly<{
  checkpoints: FileCheckpointSaver;
  source: string;
  candidates: string;
  promotions: string;
  request: BacktrackRequestV1;
  input: (ledger?: EffectLedger) => Parameters<typeof preflightBacktrack>[1];
  dispose: () => Promise<void>;
}>;

type RejectionKind = Exclude<BacktrackPreflightResult["kind"], "accepted">;
type RejectionCase = Readonly<{
  expected: RejectionKind;
  request: (fixture: Fixture) => BacktrackRequestV1;
  fixtureLedger: EffectLedger;
  ledger: EffectLedger;
  moveHead?: boolean;
  terminal?: boolean;
}>;

async function createFixture(ledger: EffectLedger = SAFE_LEDGER, terminal = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-backtrack-"));
  const source = join(root, "source"); const candidates = join(root, "candidates"); const promotions = join(root, "promotions");
  await Promise.all([mkdir(source), mkdir(candidates), mkdir(promotions)]);
  await writeFile(join(source, "tracked.txt"), "baseline\n");
  runGit(source, ["init", "--initial-branch=main"]); runGit(source, ["add", "tracked.txt"]);
  runGit(source, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "baseline"]);
  const sourceSnapshot = await createRepositorySnapshot(source);
  const checkpoints = await FileCheckpointSaver.open(join(root, "checkpoints"));
  checkpoints.bindRepositorySnapshot("thread-01", { protocolVersion: 1, snapshotId: sourceSnapshot.snapshotId, head: sourceSnapshot.head });
  checkpoints.bindReplaySafety("thread-01", {
    bridgeProtocolVersion: 1, workflowVersion: 2, stateVersion: 3, workflowInput: { objective: "test" },
    toolModelConfigDigest: modelDigest, effectLedgerDigest: effectLedgerDigest(ledger),
  });
  await checkpoints.put({ configurable: { thread_id: "thread-01" } }, checkpoint("checkpoint-01", terminal), { source: "loop", step: 1, parents: {} }, {});
  const tuple = await checkpoints.getTuple({ configurable: { thread_id: "thread-01", checkpoint_id: "checkpoint-01" } });
  const replay = tuple === undefined ? undefined : checkpointReplayMetadata(tuple.metadata);
  if (replay?.replayFingerprint === undefined) throw new Error("fixture replay metadata missing");
  const request = decodeBacktrackRequest({ protocolVersion: 1, requestId: "request-01", sessionId: "session-01", entryId: "entry-01", candidateIndices: [0, 1], link: {
    protocolVersion: 1, entryType: "pi-langgraph/checkpoint-link", threadId: "thread-01", checkpointId: "checkpoint-01", label: "pre-mutation",
    repositorySnapshot: { protocolVersion: 1, snapshotId: sourceSnapshot.snapshotId, baselineHead: sourceSnapshot.head }, replayFingerprint: replay.replayFingerprint, effectLedgerDigest: effectLedgerDigest(ledger),
  } });
  return { checkpoints, source, candidates, promotions, request,
    input: (inputLedger = ledger) => ({ checkpoints, sourceDirectory: source, effectLedger: inputLedger, snapshotExists: async (id: string) => id === sourceSnapshot.snapshotId }),
    dispose: async () => rm(root, { recursive: true, force: true }) };
}

function checkpoint(id: string, terminal: boolean) {
  return { v: 1, id, ts: new Date(0).toISOString(), channel_values: terminal ? { status: "completed" } : {}, channel_versions: {}, versions_seen: {} };
}

async function sourceProof(fixture: Fixture): Promise<readonly [string, readonly string[], readonly string[]]> {
  return [(await createRepositorySnapshot(fixture.source)).snapshotId, await readdir(fixture.candidates), await readdir(fixture.promotions)];
}

function runGit(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
}

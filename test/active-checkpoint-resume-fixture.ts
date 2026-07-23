import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedCheckpointLink } from "../src/bridge/session-checkpoint-bridge.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
} from "../src/persistence/checkpoint-thread-codec.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { createOrchestrationDispatcher } from "../src/runtime/orchestration-dispatcher.ts";
import type { OrchestrationInput } from "../src/runtime/public-contract.ts";
import type { LangGraphExtensionAPI, RuntimeContext } from "../src/types.ts";

type ResumeDecision = NonNullable<
  Extract<OrchestrationInput, { readonly resumeThreadId: string }>["decision"]
>;

export type PausedResumeFixture = Readonly<{
  repository: string;
  context: RuntimeContext;
  threadId: string;
  dispatcher: ReturnType<typeof createOrchestrationDispatcher>;
  older: ResolvedCheckpointLink;
  latest: ResolvedCheckpointLink;
  decision: ResumeDecision;
  select(link: ResolvedCheckpointLink): void;
  resetWorkerStarts(): void;
  workerStarts(): number;
  close(): Promise<void>;
}>;

export async function createPausedResumeFixture(name: string): Promise<PausedResumeFixture> {
  const root = await mkdtemp(join(tmpdir(), `pi-active-resume-${name}-`));
  const repository = join(root, "repository");
  const dataRoot = join(root, "data");
  const threadId = `active-${name}`;
  const context: RuntimeContext = { cwd: repository, model: undefined };
  await mkdir(repository);
  await writeFile(join(repository, "feature.ts"), "export const source = true;\n");
  await writeFile(join(repository, "sibling.ts"), "export const sibling = true;\n");
  await writeFile(
    join(repository, "package.json"),
    JSON.stringify({ scripts: { "check:resume": "printf resume-evidence" } }),
  );
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi Resume Test"]);
  git(repository, ["config", "user.email", "pi-resume@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);

  let active: ResolvedCheckpointLink | undefined;
  let starts = 0;
  const dispatcher = createOrchestrationDispatcher(workflowPi(() => {
    starts += 1;
  }), dataRoot, {
    resolveActiveLink: async () => active,
  });
  const paused = await dispatcher({
    input: { objective: "Implement guarded change", threadId },
    context,
  });
  const interrupt = record(record(paused.details).interrupt);
  const checkpoints = await FileCheckpointSaver.open(join(dataRoot, "checkpoints"));
  const latestTuple = await checkpoints.getTuple({ configurable: { thread_id: threadId } });
  if (latestTuple === undefined) throw new ActiveResumeFixtureError("latest checkpoint missing");
  const tuples: CheckpointTuple[] = [];
  for await (const tuple of checkpoints.list({ configurable: { thread_id: threadId } })) tuples.push(tuple);
  const olderTuple = tuples.find((tuple) =>
    tuple.checkpoint.id !== latestTuple.checkpoint.id &&
    (checkpointReplayMetadata(tuple.metadata)?.semanticLabels.length ?? 0) > 0
  );
  if (olderTuple === undefined) throw new ActiveResumeFixtureError("older semantic checkpoint missing");
  return {
    repository,
    context,
    threadId,
    dispatcher,
    older: resolvedLink(threadId, olderTuple),
    latest: resolvedLink(threadId, latestTuple),
    decision: decisionFromInterrupt(interrupt),
    select(link) {
      active = link;
    },
    resetWorkerStarts() {
      starts = 0;
    },
    workerStarts: () => starts,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

function resolvedLink(threadId: string, tuple: CheckpointTuple): ResolvedCheckpointLink {
  const replay = checkpointReplayMetadata(tuple.metadata);
  const repository = repositoryCheckpointIdentity(tuple.metadata);
  const label = replay?.semanticLabels.at(-1);
  if (replay?.replayBinding === undefined || replay.replayFingerprint === undefined ||
      repository === undefined || label === undefined) {
    throw new ActiveResumeFixtureError("checkpoint replay link missing");
  }
  return {
    sessionId: "session-active",
    entryId: `entry-${tuple.checkpoint.id}`,
    link: {
      protocolVersion: 1,
      entryType: "pi-langgraph/checkpoint-link",
      threadId,
      checkpointId: tuple.checkpoint.id,
      label,
      repositorySnapshot: {
        protocolVersion: 1,
        snapshotId: repository.snapshotId,
        baselineHead: repository.head,
      },
      replayFingerprint: replay.replayFingerprint,
      effectLedgerDigest: replay.replayBinding.effectLedgerDigest,
    },
  };
}

function workflowPi(onWorker: () => void): LangGraphExtensionAPI {
  return {
    registerTool() {},
    getActiveTools: () => ["task"],
    async executeTool(_name, params) {
      onWorker();
      const value = record(params);
      return {
        content: [{ type: "text", text: JSON.stringify(outputFor(string(value.name))) }],
        details: { status: "completed" },
      };
    },
  };
}

function outputFor(id: string): unknown {
  if (id === "discover") {
    return {
      workItems: [{ id: "core", title: "Core", instruction: "Inspect" }],
      acceptanceCriteria: ["check"],
      executionPlan: {
        version: 1,
        planId: "active-resume-plan",
        revision: 1,
        changes: [{
          changeId: "core",
          title: "Core",
          instruction: "Implement",
          dependsOn: [],
          scope: { files: ["feature.ts"] },
          risk: { level: "high", reasons: ["guarded"] },
          acceptanceChecks: [{ kind: "package_script", script: "check:resume" }],
          status: "pending",
        }],
      },
    };
  }
  if (id === "specialist_core") return { summary: "found", evidence: [], risks: [], discoveredWorkItems: [] };
  if (id.startsWith("implement")) return { summary: "implemented", filesChanged: [], evidence: [], unresolvedRisks: [] };
  if (id === "verify") {
    return {
      passed: true,
      summary: "passed",
      checks: [{ name: "resume", passed: true, evidence: "exit 0" }],
    };
  }
  if (id === "synthesize") return { summary: "complete" };
  throw new ActiveResumeFixtureError(`unexpected worker ${id}`);
}

function decisionFromInterrupt(interrupt: Readonly<Record<string, unknown>>): ResumeDecision {
  const scope = record(interrupt.scope);
  return {
    interruptId: string(interrupt.interruptId),
    changeId: string(interrupt.changeId),
    planId: string(interrupt.planId),
    revision: number(interrupt.revision),
    attempt: number(interrupt.attempt),
    scope: { files: stringArray(scope.files) },
    allowedScripts: stringArray(interrupt.allowedScripts),
    ...(typeof interrupt.threadId === "string" ? { threadId: interrupt.threadId } : {}),
    ...(typeof interrupt.checkpointId === "string" ? { checkpointId: interrupt.checkpointId } : {}),
    action: "approve" as const,
  };
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ActiveResumeFixtureError("expected record");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ActiveResumeFixtureError("expected string");
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number") throw new ActiveResumeFixtureError("expected number");
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ActiveResumeFixtureError("expected array");
  const items: readonly unknown[] = value;
  if (!items.every((item) => typeof item === "string")) {
    throw new ActiveResumeFixtureError("expected string array");
  }
  return items.flatMap((item) => typeof item === "string" ? [item] : []);
}

function git(cwd: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new ActiveResumeFixtureError(new TextDecoder().decode(result.stderr));
  }
}

class ActiveResumeFixtureError extends Error {
  readonly name = "ActiveResumeFixtureError";
}

import { expect, test } from "bun:test";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { MemorySaver } from "@langchain/langgraph-checkpoint";
import { resumeCodingWorkflow, runCodingWorkflow } from "../src/workflow/runtime.ts";
import {
  assertDecisionScope,
  decisionForInterrupt,
  parseInterruptDecision,
  parseScopedInterrupt,
  rebindInterruptToCurrentConfig,
} from "../src/workflow/risk-policy.ts";
import type { HostEvidence } from "../src/evidence/types.ts";
import type { TaskExecutor } from "../src/types.ts";
import type { ScopedInterrupt } from "../src/workflow/types.ts";

const evidenceRunner = {
  async defaultIntegrationScripts(): Promise<readonly string[]> {
    return ["test"];
  },
  async runPackageScript(script: string): Promise<HostEvidence> {
    return {
      script,
      packageManager: "bun",
      exitCode: 0,
      signal: null,
      durationMs: 1,
      stdout: { digest: "a".repeat(64), byteCount: 0, truncated: false },
      stderr: { digest: "b".repeat(64), byteCount: 0, truncated: false },
      passed: true,
    };
  },
};

function executorFor(calls: string[], risk: "low" | "high"): TaskExecutor {
  return {
    async execute({ task }) {
      calls.push(task.id);
      if (task.id === "discover") return JSON.stringify({
        workItems: [{ id: "danger", title: "Danger", instruction: "Change production" }],
        acceptanceCriteria: ["verified"],
        executionPlan: {
          version: 1,
          planId: `${risk}-risk-plan`,
          revision: 4,
          changes: [{
            changeId: "production",
            title: "Production",
            instruction: "Change production",
            dependsOn: [],
            scope: { files: ["src/production.ts"] },
            risk: { level: risk, reasons: risk === "high" ? ["production scope"] : [] },
            acceptanceChecks: [{ kind: "package_script", script: "test" }],
            status: "pending",
          }],
        },
      });
      if (task.id.startsWith("specialist_")) return JSON.stringify({ summary: "risk classified", evidence: [], risks: [] });
      if (task.id.startsWith("implement")) return JSON.stringify({ summary: "done", filesChanged: ["src/production.ts"], evidence: [], unresolvedRisks: [] });
      if (task.id === "verify") return JSON.stringify({ passed: true, summary: "ok", checks: [{ name: "test", passed: true, evidence: "exit 0" }] });
      return JSON.stringify({ summary: "complete" });
    },
  };
}

test("low-risk planned change does not pause without an approval policy", async () => {
  // Given: a low-risk scoped change.
  const calls: string[] = [];

  // When: the workflow runs without an explicit approval policy.
  const result = await runCodingWorkflow({ objective: "Change production" }, executorFor(calls, "low"), {
    threadId: "low-risk-contract",
    evidenceRunner,
  });

  // Then: mutation runs without an approval pause.
  expect(result.status).toBe("completed");
  expect(calls.some((call) => call.startsWith("implement"))).toBe(true);
});

test("high-risk interrupt rejects wrong-scope decisions and explicit rejection prevents mutation", async () => {
  // Given: a persisted high-risk interrupt bound to its plan, change, scope, scripts, thread, and checkpoint.
  const calls: string[] = [];
  const executor = executorFor(calls, "high");
  const checkpointer = new MemorySaver();
  const paused = await runCodingWorkflow({ objective: "Change production", approval: "before_changes" }, executor, {
    checkpointer,
    threadId: "interrupt-contract",
    retainCheckpoint: true,
    evidenceRunner,
  });
  expect(paused.status).toBe("awaiting_approval");
  if (paused.status !== "awaiting_approval" || paused.interrupt === undefined) throw new Error("missing scoped interrupt");
  expect(paused.interrupt).toMatchObject({
    planId: "high-risk-plan",
    revision: 4,
    changeId: "production",
    scope: { files: ["src/production.ts"] },
    allowedScripts: ["test"],
    threadId: "interrupt-contract",
  });

  // When: approval echoes the opaque token but changes its authorized file scope.
  const approval = decisionForInterrupt(paused.interrupt, "approve");
  await expect(
    resumeCodingWorkflow("interrupt-contract", executor, {
      checkpointer,
      retainCheckpoint: true,
      evidenceRunner,
      decision: { ...approval, scope: { files: ["src/other.ts"] } },
    }),
  ).rejects.toThrow("does not match");
  await expect(
    resumeCodingWorkflow("interrupt-contract", executor, {
      checkpointer,
      retainCheckpoint: true,
      evidenceRunner,
      decision: { ...approval, revision: approval.revision - 1 },
    }),
  ).rejects.toThrow("does not match");

  // Then: the exact structured rejection resumes once and never mutates.
  const rejected = await resumeCodingWorkflow("interrupt-contract", executor, {
    checkpointer,
    retainCheckpoint: true,
    evidenceRunner,
    decision: decisionForInterrupt(paused.interrupt, "reject"),
  });
  expect(rejected).toMatchObject({ status: "needs_attention" });
  expect(calls.some((call) => call.startsWith("implement"))).toBe(false);
});

test("rejecting a repair approval ends without running repair or further evidence", async () => {
  const calls: string[] = [];
  let evidenceCalls = 0;
  const failingEvidenceRunner = {
    async defaultIntegrationScripts(): Promise<readonly string[]> { return ["test"]; },
    async runPackageScript(script: string): Promise<HostEvidence> {
      evidenceCalls += 1;
      return {
        script,
        packageManager: "bun",
        exitCode: 1,
        signal: null,
        durationMs: 1,
        stdout: { digest: "c".repeat(64), byteCount: 0, truncated: false },
        stderr: { digest: "d".repeat(64), byteCount: 0, truncated: false },
        passed: false,
      };
    },
  };
  const checkpointer = new MemorySaver();
  const executor = executorFor(calls, "high");
  const initial = await runCodingWorkflow(
    { objective: "Change production", approval: "before_changes", maxIterations: 1 },
    executor,
    { checkpointer, threadId: "reject-repair", retainCheckpoint: true, evidenceRunner: failingEvidenceRunner },
  );
  if (initial.status !== "awaiting_approval") throw new Error("initial workflow did not pause");
  const repair = await resumeCodingWorkflow("reject-repair", executor, {
    checkpointer,
    retainCheckpoint: true,
    evidenceRunner: failingEvidenceRunner,
    decision: decisionForInterrupt(initial.interrupt, "approve"),
  });
  if (repair.status !== "awaiting_approval") throw new Error("repair workflow did not pause");
  const evidenceBeforeRejection = evidenceCalls;

  const rejected = await resumeCodingWorkflow("reject-repair", executor, {
    checkpointer,
    retainCheckpoint: true,
    evidenceRunner: failingEvidenceRunner,
    decision: decisionForInterrupt(repair.interrupt, "reject"),
  });

  expect(rejected.status).toBe("needs_attention");
  expect(calls.some((call) => call.startsWith("repair"))).toBe(false);
  expect(evidenceCalls).toBe(evidenceBeforeRejection);
});

test("fork clone without interrupt task writes rebuilds approval before accepting a decision", async () => {
  // Given: a paused source checkpoint cloned without its nonportable interrupt task writes.
  const calls: string[] = [];
  const executor = executorFor(calls, "high");
  const sourceCheckpointer = new MemorySaver();
  const source = await runCodingWorkflow(
    { objective: "Change production", approval: "before_changes" },
    executor,
    { checkpointer: sourceCheckpointer, threadId: "source-clone", retainCheckpoint: true, evidenceRunner },
  );
  if (source.status !== "awaiting_approval") throw new Error("source workflow did not pause");
  const sourceTuple = await sourceCheckpointer.getTuple({ configurable: { thread_id: "source-clone" } });
  if (sourceTuple === undefined) throw new Error("source checkpoint is missing");
  if (sourceTuple.metadata === undefined) throw new Error("source checkpoint metadata is missing");
  const forkCheckpointer = new MemorySaver();
  await forkCheckpointer.put(
    { configurable: { thread_id: "fork-clone", checkpoint_ns: "" } },
    sourceTuple.checkpoint,
    sourceTuple.metadata,
  );

  // When: approval is attempted before the fork has recreated a resumable interrupt.
  await expect(
    resumeCodingWorkflow("fork-clone", executor, {
      checkpointer: forkCheckpointer,
      retainCheckpoint: true,
      evidenceRunner,
      approved: true,
    }),
  ).rejects.toThrow("no pending approval");
  const rebuilt = await resumeCodingWorkflow("fork-clone", executor, {
    checkpointer: forkCheckpointer,
    retainCheckpoint: true,
    evidenceRunner,
  });

  // Then: the emitted interrupt is fork-bound and only its exact decision can mutate.
  if (rebuilt.status !== "awaiting_approval") throw new Error("fork workflow did not rebuild approval");
  expect(rebuilt.interrupt.threadId).toBe("fork-clone");
  expect(rebuilt.interrupt.interruptId).not.toBe(source.interrupt.interruptId);
  expect(calls.some((call) => call.startsWith("implement"))).toBe(false);
  const completed = await resumeCodingWorkflow("fork-clone", executor, {
    checkpointer: forkCheckpointer,
    retainCheckpoint: true,
    evidenceRunner,
    decision: decisionForInterrupt(rebuilt.interrupt, "approve"),
  });
  expect(completed.status).toBe("completed");
  expect(calls.some((call) => call.startsWith("implement"))).toBe(true);
});

test("source-bound interrupt is rebound to a new thread and exact resume succeeds", async () => {
  // Given: a real approval interrupt persisted for a source workflow thread.
  const source = await runCodingWorkflow(
    { objective: "Change production", approval: "before_changes" },
    executorFor([], "high"),
    { checkpointer: new MemorySaver(), threadId: "source-interrupt", retainCheckpoint: true, evidenceRunner },
  );
  if (source.status !== "awaiting_approval") throw new Error("source workflow did not pause");
  const ForkApprovalState = Annotation.Root({
    pending: Annotation<ScopedInterrupt>,
    approved: Annotation<boolean>,
  });
  const graph = new StateGraph(ForkApprovalState)
    .addNode("approve", (state) => {
      const pending = rebindInterruptToCurrentConfig(state.pending);
      const decision = parseInterruptDecision(interrupt<typeof pending, unknown>(pending));
      assertDecisionScope(decision, pending);
      return { pending, approved: decision.action === "approve" };
    })
    .addEdge(START, "approve")
    .addEdge("approve", END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: "forked-interrupt" }, durability: "sync" as const };

  // When: the source payload is emitted and resumed inside the fork thread.
  const first: unknown = await graph.invoke({ pending: source.interrupt, approved: false }, config);
  const rebound = emittedInterrupt(first);
  const resumed: unknown = await graph.invoke(new Command({ resume: decisionForInterrupt(rebound, "approve") }), config);

  // Then: the token and thread are fork-local, while the exact rebound decision is accepted.
  expect(rebound.threadId).toBe("forked-interrupt");
  expect(rebound.interruptId).not.toBe(source.interrupt.interruptId);
  expect(isRecord(resumed) ? resumed.approved : undefined).toBe(true);
});

function emittedInterrupt(value: unknown): ScopedInterrupt {
  if (!isRecord(value) || !Array.isArray(value.__interrupt__)) throw new Error("graph did not emit an interrupt");
  const first = value.__interrupt__[0];
  if (!isRecord(first)) throw new Error("graph emitted an invalid interrupt");
  return parseScopedInterrupt(first.value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

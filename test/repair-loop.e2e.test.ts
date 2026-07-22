import { expect, test } from "bun:test";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { TaskExecutor } from "../src/types.ts";
import { conditionalEvidenceRunner } from "./helpers/evidence.ts";

test("routes failed verification through a bounded diagnose and repair loop", async () => {
  let verificationCalls = 0;
  const calls: string[] = [];
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      switch (request.task.id) {
        case "discover":
          return JSON.stringify({
            workItems: [{ id: "api", title: "API", instruction: "Inspect and implement the endpoint" }],
            acceptanceCriteria: ["The endpoint passes its integration test"],
          });
        case "specialist_api":
          return JSON.stringify({
            summary: "located the endpoint",
            evidence: [{ kind: "file", location: "src/api.ts", detail: "handler" }],
            risks: [],
          });
        case "implement":
          return JSON.stringify({
            summary: "implemented endpoint",
            filesChanged: ["src/api.ts"],
            evidence: ["added handler"],
            unresolvedRisks: [],
          });
        case "verify": {
          verificationCalls += 1;
          const passed = verificationCalls === 2;
          return JSON.stringify({
            passed,
            summary: passed ? "integration test passes" : "integration test failed",
            checks: [{ name: "integration", passed, evidence: passed ? "exit 0" : "expected 200, got 500" }],
          });
        }
        case "diagnose":
          return JSON.stringify({
            summary: "response was not returned",
            rootCauses: ["missing return"],
            repairInstructions: ["return the response"],
          });
        case "repair":
          return JSON.stringify({
            summary: "returned the response",
            filesChanged: ["src/api.ts"],
            evidence: ["patched missing return"],
            unresolvedRisks: [],
          });
        case "synthesize":
          return JSON.stringify({ summary: "Implemented, repaired, and verified." });
        default:
          throw new Error(`unexpected task ${request.task.id}`);
      }
    },
  };
  const evidenceRunner = conditionalEvidenceRunner(() => verificationCalls === 2);

  const result = await runCodingWorkflow(
    { objective: "Implement the API endpoint", maxIterations: 2 },
    executor,
    { threadId: "repair-once", retainCheckpoint: true, evidenceRunner },
  );

  expect(result.status).toBe("completed");
  expect(result.iteration).toBe(1);
  expect(verificationCalls).toBe(2);
  expect(calls).toEqual([
    "discover",
    "specialist_api",
    "implement",
    "verify",
    "diagnose",
    "repair",
    "verify",
    "synthesize",
  ]);
  expect(result.trace.filter((event) => event.node === "verify").map((event) => event.route)).toEqual([
    "diagnose",
    "synthesize",
  ]);
});

test("never delivers an unverified mutation when the repair bound is exhausted", async () => {
  const calls: string[] = [];
  const executor: TaskExecutor = {
    async execute(request) {
      calls.push(request.task.id);
      if (request.task.id === "discover") {
        return JSON.stringify({
          workItems: [{ id: "core", title: "Core", instruction: "Inspect core" }],
          acceptanceCriteria: ["tests pass"],
        });
      }
      if (request.task.id === "specialist_core") {
        return JSON.stringify({ summary: "found core", evidence: [], risks: [] });
      }
      if (request.task.id === "implement" || request.task.id === "repair") {
        return JSON.stringify({
          summary: "changed core",
          filesChanged: ["src/core.ts"],
          evidence: ["change applied"],
          unresolvedRisks: [],
        });
      }
      if (request.task.id === "verify") {
        return JSON.stringify({
          passed: false,
          summary: "still failing",
          checks: [{ name: "tests", passed: false, evidence: "exit 1" }],
        });
      }
      if (request.task.id === "diagnose") {
        return JSON.stringify({
          summary: "persistent defect",
          rootCauses: ["unknown"],
          repairInstructions: ["try bounded repair"],
        });
      }
      if (request.task.id === "synthesize") return JSON.stringify({ summary: "must not run" });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };
  const evidenceRunner = conditionalEvidenceRunner(() => false);

  const result = await runCodingWorkflow(
    { objective: "Fix core", maxIterations: 1 },
    executor,
    { threadId: "repair-exhausted", retainCheckpoint: true, evidenceRunner },
  );

  expect(result.status).toBe("needs_attention");
  expect(result.iteration).toBe(1);
  expect(result.verification?.passed).toBe(false);
  expect(calls.includes("synthesize")).toBe(false);
  expect(result.unresolvedRisks).toContain("Verification still fails after 1 repair iteration.");
});

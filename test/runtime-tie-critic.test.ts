import { expect, test } from "bun:test";
import { createRuntimeTieCritic } from "../src/runtime/tie-critic.ts";
import { resolveCandidateScore, type CandidateScoreInput } from "../src/workflow/candidate-scoring.ts";
import type { LangGraphExtensionAPI } from "../src/types.ts";

test("runtime Pi critic is called only after a true deterministic tie", async () => {
  let calls = 0;
  const critic = createRuntimeTieCritic({
    pi: piWorker(() => {
      calls += 1;
      return { protocolVersion: 1, winnerCandidateIndex: 1 };
    }),
    context: { cwd: "/tmp", model: undefined },
  });

  const nonTie = await resolveCandidateScore([
    candidate(0),
    candidate(1, { changedBytes: 11 }),
  ], critic);
  const tie = await resolveCandidateScore([candidate(0), candidate(1)], critic);

  expect(nonTie.winner.candidateIndex).toBe(0);
  expect(tie.winner.candidateIndex).toBe(1);
  expect(calls).toBe(1);
});

function candidate(
  candidateIndex: 0 | 1,
  overrides: Partial<CandidateScoreInput> = {},
): CandidateScoreInput {
  return {
    candidateIndex,
    replayCompatible: true,
    effects: { fullyKnown: true, fullyCompensable: true },
    deliveryCompleted: true,
    hostVerification: { passed: true, failedChecks: 0 },
    unresolvedRisks: [],
    changedPaths: ["tracked.txt"],
    changedBytes: 10,
    ...overrides,
  };
}

function piWorker(decision: () => Readonly<{ protocolVersion: 1; winnerCandidateIndex: 0 | 1 }>): LangGraphExtensionAPI {
  return {
    registerTool() {},
    getActiveTools: () => ["task"],
    async executeTool() {
      return {
        content: [{ type: "text", text: JSON.stringify(decision()) }],
        details: { status: "completed" },
      };
    },
  };
}

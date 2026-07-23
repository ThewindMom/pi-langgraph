import { describe, expect, test } from "bun:test";
import {
  CandidateTieCriticError,
  resolveCandidateScore,
  scoreCandidates,
  type CandidateScoreInput,
} from "../src/workflow/candidate-scoring.ts";

const candidate = (index: 0 | 1, overrides: Partial<CandidateScoreInput> = {}): CandidateScoreInput => ({
  candidateIndex: index,
  replayCompatible: true,
  effects: { fullyKnown: true, fullyCompensable: true },
  deliveryCompleted: true,
  hostVerification: { passed: true, failedChecks: 0 },
  unresolvedRisks: [],
  changedPaths: ["src/a.ts"],
  changedBytes: 10,
  summary: "ignored prose",
  ...overrides,
});

describe("candidate scoring", () => {
  test("selects a deterministic non-tie without invoking a critic", async () => {
    // Given: candidate 0 has a strictly better deterministic verification dimension.
    let calls = 0;
    const critic = async () => {
      calls += 1;
      return { protocolVersion: 1, winnerCandidateIndex: 1 };
    };

    // When: candidates are resolved in reverse input order.
    const result = await resolveCandidateScore([
      candidate(1, { checkFailures: { test: 1, typecheck: 0, lint: 0, build: 0 } }),
      candidate(0),
    ], critic);

    // Then: dimensions decide the winner and no model boundary is crossed.
    expect(result.winner.candidateIndex).toBe(0);
    expect(result.tieDecision).toBeNull();
    expect(calls).toBe(0);
  });

  test("is order independent when deterministic dimensions differ", () => {
    const first = scoreCandidates([candidate(1, { changedBytes: 20 }), candidate(0)]);
    const second = scoreCandidates([candidate(0), candidate(1, { changedBytes: 20 })]);
    expect(first.kind).toBe("selected");
    expect(second.kind).toBe("selected");
    if (first.kind !== "selected" || second.kind !== "selected") throw new Error("expected deterministic selections");
    expect(first.winner.candidateIndex).toBe(0);
    expect(first.receipts).toEqual(second.receipts);
  });

  test("rejects unsafe candidate regardless of prose", () => {
    const result = scoreCandidates([
      candidate(0, { replayCompatible: false, summary: "all checks passed" }),
      candidate(1),
    ]);
    if (result.kind !== "selected") throw new Error("expected deterministic selection");
    expect(result.winner.candidateIndex).toBe(1);
    expect(result.receipts[0]?.eligible).toBe(false);
  });

  test("orders deterministic verification dimensions before risks and diffs", () => {
    const result = scoreCandidates([
      candidate(0, { unmetAcceptanceCriteria: 0 }),
      candidate(1, { checkFailures: { test: 1, typecheck: 0, lint: 0, build: 0 }, unresolvedRisks: ["risk"], changedBytes: 1_000 }),
    ]);
    if (result.kind !== "selected") throw new Error("expected deterministic selection");
    expect(result.winner.candidateIndex).toBe(0);
  });

  test("invokes exactly one structured critic for a true dimensional tie", async () => {
    // Given: all deterministic dimensions are equal, while prose differs.
    let calls = 0;
    const critic = async () => {
      calls += 1;
      return { protocolVersion: 1, winnerCandidateIndex: 1 };
    };

    // When: the tied pair is resolved.
    const result = await resolveCandidateScore([
      candidate(0, { summary: "z" }),
      candidate(1, { summary: "a" }),
    ], critic);

    // Then: the bounded decision is recorded and selects only a candidate in the tied pair.
    expect(calls).toBe(1);
    expect(result.winner.candidateIndex).toBe(1);
    expect(result.tieDecision).toEqual({ protocolVersion: 1, winnerCandidateIndex: 1 });
  });

  test("fails closed when a true tie has no valid critic decision", async () => {
    // Given: a true tie and a critic with an unconstrained response.
    const tied = [candidate(0), candidate(1)] as const;

    // When / Then: unavailable and malformed critic outcomes cannot promote either candidate.
    await expect(resolveCandidateScore(tied)).rejects.toBeInstanceOf(CandidateTieCriticError);
    await expect(resolveCandidateScore(tied, async () => ({ winnerCandidateIndex: 2 })))
      .rejects.toBeInstanceOf(CandidateTieCriticError);
  });
});

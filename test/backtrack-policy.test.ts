import { describe, expect, test } from "bun:test";
import { classifyBacktrackTrigger, type BacktrackPolicyInput } from "../src/workflow/backtrack-policy.js";

const base: BacktrackPolicyInput = {
  failedChecks: { test: 1, typecheck: 0, lint: 0, build: 0 },
  repeatedFailureSignature: false,
  noProgress: false,
  regressions: 0,
  diagnosis: { planInvalidating: false },
  iteration: { current: 1, budget: 5 },
  effects: { safe: true },
  replay: { compatible: true },
  risk: { ambiguous: false },
};

describe("backtrack policy", () => {
  test("retries a recoverable current repair", () => {
    expect(classifyBacktrackTrigger(base).action).toBe("retry-current-repair");
  });

  test("compares exactly two candidates after repeated no progress", () => {
    expect(classifyBacktrackTrigger({ ...base, repeatedFailureSignature: true, noProgress: true }).action).toBe("compare-two-candidates");
    expect(classifyBacktrackTrigger({ ...base, repeatedFailureSignature: true }).candidateCount).toBe(2);
  });

  test("escalates when diagnosis invalidates the plan or safety is uncertain", () => {
    expect(classifyBacktrackTrigger({ ...base, diagnosis: { planInvalidating: true } }).action).toBe("escalate-manual");
    expect(classifyBacktrackTrigger({ ...base, effects: { safe: false } }).action).toBe("escalate-manual");
  });

  test("compares two candidates after the linear repair budget is exhausted", () => {
    expect(classifyBacktrackTrigger({
      ...base,
      repeatedFailureSignature: true,
      noProgress: true,
      iteration: { current: 5, budget: 5 },
    })).toEqual({
      action: "compare-two-candidates",
      candidateCount: 2,
      reason: "repeated-no-progress",
    });
  });

  test("escalates high ambiguity", () => {
    expect(classifyBacktrackTrigger({ ...base, risk: { ambiguous: true } }).action).toBe("escalate-manual");
  });
});

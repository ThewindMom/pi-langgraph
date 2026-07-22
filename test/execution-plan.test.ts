import { expect, test } from "bun:test";
import { parseExecutionPlan } from "../src/workflow/execution-plan.ts";

const change = (changeId: string, dependsOn: readonly string[] = []) => ({
  changeId,
  title: `Change ${changeId}`,
  instruction: `Implement ${changeId}`,
  dependsOn,
  scope: { files: [`src/${changeId}.ts`] },
  risk: { level: "low" as const, reasons: [] },
  acceptanceChecks: [{ kind: "package_script" as const, script: "test" }],
});

test("rejects malformed plans at the worker boundary", () => {
  expect(() => parseExecutionPlan({ version: 1, planId: "plan-1" })).toThrow();
});

test("rejects duplicate change IDs before any mutation can be claimed", () => {
  const malformed = {
    version: 1,
    planId: "plan-1",
    revision: 1,
    changes: [change("same"), change("same")],
  };
  expect(() => parseExecutionPlan(malformed)).toThrow();
});

test("rejects dependency cycles before any mutation can be claimed", () => {
  const cyclic = {
    version: 1,
    planId: "plan-1",
    revision: 1,
    changes: [change("a", ["b"]), change("b", ["a"])],
  };
  expect(() => parseExecutionPlan(cyclic)).toThrow();
});

test("rejects unsafe or non-normalized repository scope paths", () => {
  for (const path of ["/tmp/escape.ts", "../escape.ts", "src/../escape.ts", "src\\escape.ts", "./src/core.ts"]) {
    const malformed = {
      version: 1,
      planId: "plan-scope",
      revision: 1,
      changes: [{ ...change("scope"), scope: { files: [path] } }],
    };
    expect(() => parseExecutionPlan(malformed)).toThrow("repository-relative path");
  }
});

import { expect, test } from "bun:test";
import { validatePlanTransition } from "../src/workflow/execution-plan.ts";
import type { PlanChangeStatus } from "../src/workflow/types.ts";

const change = (changeId: string, dependsOn: readonly string[] = [], status: PlanChangeStatus = "pending") => ({
  changeId,
  title: `Change ${changeId}`,
  instruction: `Implement ${changeId}`,
  dependsOn,
  scope: { files: [`src/${changeId}.ts`] },
  risk: { level: "low" as const, reasons: [] },
  acceptanceChecks: [{ kind: "package_script" as const, script: "test" }],
  status,
});

const plan = (revision: number, changes = [change("a")]) => ({
  version: 1 as const,
  planId: "plan-revision",
  revision,
  changes,
});

test("rejects stale and same plan revisions", () => {
  // Given: durable revision two.
  const previous = plan(2);

  // When/Then: neither an older nor an unapproved same revision can replace it.
  expect(() => validatePlanTransition(previous, plan(1))).toThrow("advance");
  expect(() => validatePlanTransition(previous, plan(2))).toThrow("advance");
});

test("allows an explicitly approved byte-identical replay", () => {
  // Given: an exact durable-plan replay.
  const previous = plan(2);

  // When: replay is explicitly enabled.
  const replayed = validatePlanTransition(previous, previous, { allowIdenticalReplay: true });

  // Then: the durable definition is preserved.
  expect(replayed).toEqual(previous);
});

test("rejects a later revision that redefines an existing change", () => {
  // Given: a claimed durable change.
  const previous = plan(2, [change("a", [], "claimed")]);
  const redefined = { ...change("a", [], "claimed"), instruction: "Replace the claimed implementation" };

  // When/Then: a higher revision cannot rewrite its definition.
  expect(() => validatePlanTransition(previous, plan(3, [redefined]))).toThrow("redefine");
});

test("accepts a monotonic append-only plan revision", () => {
  // Given: one durable change.
  const previous = plan(2);

  // When: a new dependent change is appended at a higher revision.
  const next = validatePlanTransition(previous, plan(3, [change("a"), change("b", ["a"])]));

  // Then: both definitions and the appended dependency are retained.
  expect(next.revision).toBe(3);
  expect(next.changes.map((item) => item.changeId)).toEqual(["a", "b"]);
  expect(next.changes[1]?.dependsOn).toEqual(["a"]);
});

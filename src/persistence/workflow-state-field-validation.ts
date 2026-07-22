import { boolean, invalid, integer, items, optional, record, strings, text } from "./workflow-validation-primitives.ts";

export const WORK_ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const PLAN_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const ARTIFACT_DIGEST = /^[a-f0-9]{64}$/;
export const TRACE_NODES = new Set(["classify", "discover", "specialist", "replan", "implement", "verify", "diagnose", "repair", "synthesize", "escalate"]);

export function validateWorkItem(value: unknown, field: string): void {
  const item = record(value, field);
  const id = text(item.id, `${field}.id`, 48);
  if (!WORK_ITEM_ID.test(id)) invalid(`${field}.id`);
  text(item.title, `${field}.title`, 200);
  text(item.instruction, `${field}.instruction`, 2_000);
}

export function validateFinding(value: unknown, field: string): void {
  const finding = record(value, field);
  text(finding.workItemId, `${field}.workItemId`, 48);
  text(finding.summary, `${field}.summary`, 8_000);
  items(finding.evidence, `${field}.evidence`, 32, (entry: unknown, entryField: string) => {
    const evidence = record(entry, entryField);
    if (evidence.kind !== "file" && evidence.kind !== "test" && evidence.kind !== "runtime" && evidence.kind !== "documentation" && evidence.kind !== "other") invalid(`${entryField}.kind`);
    text(evidence.location, `${entryField}.location`, 1_000);
    text(evidence.detail, `${entryField}.detail`, 2_000);
  });
  strings(finding.risks, `${field}.risks`, 32, 4_000);
  items(finding.discoveredWorkItems, `${field}.discoveredWorkItems`, 4, validateWorkItem);
}

export function validateChange(value: unknown, field: string): void {
  const change = record(value, field);
  if (change.kind !== "implementation" && change.kind !== "repair") invalid(`${field}.kind`);
  text(change.summary, `${field}.summary`, 8_000);
  strings(change.filesChanged, `${field}.filesChanged`, 32, 4_000);
  strings(change.evidence, `${field}.evidence`, 32, 4_000);
  strings(change.unresolvedRisks, `${field}.unresolvedRisks`, 32, 4_000);
}

export function validateVerification(value: unknown): boolean {
  const verification = record(value, "verification");
  boolean(verification.passed, "verification.passed");
  text(verification.summary, "verification.summary", 8_000);
  const checks = items(verification.checks, "verification.checks", 32, (entry: unknown, field: string) => { const check = record(entry, field); text(check.name, `${field}.name`, 500); boolean(check.passed, `${field}.passed`); text(check.evidence, `${field}.evidence`, 4_000); }, 1);
  const allPassed = checks.every((entry: unknown, index: number) => record(entry, `verification.checks[${index}]`).passed === true);
  if (verification.passed !== allPassed) invalid("verification.passed");
  return verification.passed;
}

export function validateDiagnostic(value: unknown): void { const diagnostic = record(value, "diagnostic"); text(diagnostic.summary, "diagnostic.summary", 8_000); strings(diagnostic.rootCauses, "diagnostic.rootCauses", 32, 4_000, 1); strings(diagnostic.repairInstructions, "diagnostic.repairInstructions", 32, 4_000, 1); }

export function validateTrace(value: unknown, field: string): void {
  const event = record(value, field);
  if (typeof event.node !== "string" || !TRACE_NODES.has(event.node)) invalid(`${field}.node`);
  integer(event.iteration, `${field}.iteration`, 0, 5);
  if (event.workItemId !== undefined) text(event.workItemId, `${field}.workItemId`, 48);
  if (event.route !== undefined && event.route !== "implement" && event.route !== "synthesize" && event.route !== "diagnose" && event.route !== "escalate" && event.route !== "verify") invalid(`${field}.route`);
}

export function validateExecutionPlan(value: unknown): {
  readonly planId: string;
  readonly revision: number;
  readonly changeIds: ReadonlySet<string>;
} {
  const plan = record(value, "plan");
  if (plan.version !== 1) invalid("plan.version");
  const planId = text(plan.planId, "plan.planId", 128);
  if (!PLAN_ID.test(planId)) invalid("plan.planId");
  const revision = integer(plan.revision, "plan.revision", 1, Number.MAX_SAFE_INTEGER);
  const changes = items(plan.changes, "plan.changes", 16, validatePlanChange, 1);
  const changeIds = new Set<string>();
  const dependenciesById = new Map<string, readonly string[]>();
  for (const [index, value] of changes.entries()) {
    const change = record(value, `plan.changes[${index}]`);
    const changeId = text(change.changeId, `plan.changes[${index}].changeId`, 48);
    if (changeIds.has(changeId)) invalid(`plan.changes[${index}].changeId`);
    changeIds.add(changeId);
  }
  for (const [index, value] of changes.entries()) {
    const change = record(value, `plan.changes[${index}]`);
    const changeId = text(change.changeId, `plan.changes[${index}].changeId`, 48);
    const dependencies = items(change.dependsOn, `plan.changes[${index}].dependsOn`, 16, () => undefined);
    const seen = new Set<string>();
    const dependencyIds: string[] = [];
    for (const [dependencyIndex, dependency] of dependencies.entries()) {
      const field = `plan.changes[${index}].dependsOn[${dependencyIndex}]`;
      const dependencyId = text(dependency, field, 48);
      if (!changeIds.has(dependencyId) || dependencyId === changeId || seen.has(dependencyId)) invalid(field);
      seen.add(dependencyId);
      dependencyIds.push(dependencyId);
    }
    dependenciesById.set(changeId, dependencyIds);
  }
  const remaining = new Set(changeIds);
  while (remaining.size > 0) {
    let progressed = false;
    for (const changeId of remaining) {
      if ((dependenciesById.get(changeId) ?? []).some((dependency) => remaining.has(dependency))) continue;
      remaining.delete(changeId);
      progressed = true;
    }
    if (!progressed) invalid("plan.changes dependencies");
  }
  return { planId, revision, changeIds };
}

function validatePlanChange(value: unknown, field: string): void {
  const change = record(value, field);
  const changeId = text(change.changeId, `${field}.changeId`, 48);
  if (!WORK_ITEM_ID.test(changeId)) invalid(`${field}.changeId`);
  text(change.title, `${field}.title`, 200);
  text(change.instruction, `${field}.instruction`, 8_000);
  strings(change.dependsOn, `${field}.dependsOn`, 16, 48);
  const scope = record(change.scope, `${field}.scope`);
  strings(scope.files, `${field}.scope.files`, 64, 400, 1);
  const risk = record(change.risk, `${field}.risk`);
  if (risk.level !== "low" && risk.level !== "medium" && risk.level !== "high") invalid(`${field}.risk.level`);
  strings(risk.reasons, `${field}.risk.reasons`, 16, 4_000);
  items(change.acceptanceChecks, `${field}.acceptanceChecks`, 16, (checkValue, checkField) => {
    const check = record(checkValue, checkField);
    if (check.kind !== "package_script") invalid(`${checkField}.kind`);
    text(check.script, `${checkField}.script`, 200);
  }, 1);
  if (change.status !== "pending" && change.status !== "claimed" && change.status !== "applied" && change.status !== "failed") invalid(`${field}.status`);
}

export function validateArtifactRef(value: unknown, field: string): void {
  const artifact = record(value, field);
  const digest = text(artifact.digest, `${field}.digest`, 64);
  if (!ARTIFACT_DIGEST.test(digest)) invalid(`${field}.digest`);
  integer(artifact.byteCount, `${field}.byteCount`, 0, Number.MAX_SAFE_INTEGER);
  boolean(artifact.truncated, `${field}.truncated`);
}

export function validateChangeResult(value: unknown, field: string): void {
  const result = record(value, field);
  const changeId = text(result.changeId, `${field}.changeId`, 48);
  if (!WORK_ITEM_ID.test(changeId)) invalid(`${field}.changeId`);
  if (
    result.status !== "pending" && result.status !== "running" && result.status !== "passed" &&
    result.status !== "failed" && result.status !== "needs_attention"
  ) invalid(`${field}.status`);
  integer(result.attempt, `${field}.attempt`, 0, Number.MAX_SAFE_INTEGER);
  items(result.evidenceRefs, `${field}.evidenceRefs`, 64, validateArtifactRef);
  optional(result.change, (change) => validateChange(change, `${field}.change`));
  optional(result.verification, validateVerification);
}

export function validateInterrupt(value: unknown): {
  readonly planId: string;
  readonly revision: number;
  readonly changeId: string;
} {
  const interrupt = record(value, "interrupt");
  const interruptId = text(interrupt.interruptId, "interrupt.interruptId", 128);
  if (!PLAN_ID.test(interruptId)) invalid("interrupt.interruptId");
  const changeId = text(interrupt.changeId, "interrupt.changeId", 48);
  if (!WORK_ITEM_ID.test(changeId)) invalid("interrupt.changeId");
  const planId = text(interrupt.planId, "interrupt.planId", 128);
  if (!PLAN_ID.test(planId)) invalid("interrupt.planId");
  const revision = integer(interrupt.revision, "interrupt.revision", 1, Number.MAX_SAFE_INTEGER);
  strings(interrupt.reasons, "interrupt.reasons", 16, 4_000, 1);
  const scope = record(interrupt.scope, "interrupt.scope");
  strings(scope.files, "interrupt.scope.files", 64, 400, 1);
  return { planId, revision, changeId };
}

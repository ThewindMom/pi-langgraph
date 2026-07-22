import { boolean, invalid, integer, items, record, strings, text } from "./workflow-validation-primitives.js";

export const WORK_ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
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

import {
  MAX_WORK_ITEMS,
  type ChangeSet,
  type DiagnosticResult,
  type DiscoveryResult,
  type Finding,
  type FindingEvidence,
  type VerificationCheck,
  type VerificationResult,
  type WorkItem,
} from "./types.ts";

const WORK_ITEM_ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const MAX_TEXT = 8_000;
const MAX_SYNTHESIS_TEXT = 32_000;
const MAX_LIST = 32;
const MAX_WORKER_OUTPUT = 262_144;

export class InvalidWorkerOutputError extends Error {
  readonly name = "InvalidWorkerOutputError";
}

export function parseDiscovery(text: string): DiscoveryResult {
  const value = parseObject(text, "discovery");
  exactFields(value, ["workItems", "acceptanceCriteria"], "discovery");
  const rawItems = array(value.workItems, "workItems", 1, MAX_WORK_ITEMS);
  const seen = new Set<string>();
  const workItems: WorkItem[] = rawItems.map((item, index) => parseWorkItem(item, `workItems[${index}]`, seen));
  return {
    workItems,
    acceptanceCriteria: stringArray(value.acceptanceCriteria, "acceptanceCriteria", 1, MAX_LIST),
  };
}

export function parseFinding(text: string, workItemId: string): Finding {
  const value = parseObject(text, "specialist finding");
  exactFields(value, ["summary", "evidence", "risks", "discoveredWorkItems"], "specialist finding");
  const rawEvidence = array(value.evidence, "evidence", 0, MAX_LIST);
  const evidence: FindingEvidence[] = rawEvidence.map((item, index) => {
    const record = recordValue(item, `evidence[${index}]`);
    exactFields(record, ["kind", "location", "detail"], `evidence[${index}]`);
    const kind = record.kind;
    if (kind !== "file" && kind !== "test" && kind !== "runtime" && kind !== "documentation" && kind !== "other") {
      throw new InvalidWorkerOutputError(`evidence[${index}].kind is invalid`);
    }
    return {
      kind,
      location: textValue(record.location, `evidence[${index}].location`, 1_000),
      detail: textValue(record.detail, `evidence[${index}].detail`, 2_000),
    };
  });
  return {
    workItemId,
    summary: textValue(value.summary, "summary", MAX_TEXT),
    evidence,
    risks: stringArray(value.risks, "risks", 0, MAX_LIST),
    discoveredWorkItems:
      value.discoveredWorkItems === undefined || value.discoveredWorkItems === null
        ? []
        : array(value.discoveredWorkItems, "discoveredWorkItems", 0, 4).map((item, index) =>
            parseWorkItem(item, `discoveredWorkItems[${index}]`, new Set<string>()),
          ),
  };
}

export function parseChangeSet(text: string, kind: ChangeSet["kind"]): ChangeSet {
  const value = parseObject(text, `${kind} change set`);
  exactFields(value, ["summary", "filesChanged", "evidence", "unresolvedRisks"], `${kind} change set`);
  return {
    kind,
    summary: textValue(value.summary, "summary", MAX_TEXT),
    filesChanged: stringArray(value.filesChanged, "filesChanged", 0, MAX_LIST),
    evidence: stringArray(value.evidence, "evidence", 0, MAX_LIST),
    unresolvedRisks: stringArray(value.unresolvedRisks, "unresolvedRisks", 0, MAX_LIST),
  };
}

export function parseVerification(text: string): VerificationResult {
  const value = parseObject(text, "verification");
  exactFields(value, ["passed", "summary", "checks"], "verification");
  if (typeof value.passed !== "boolean") throw new InvalidWorkerOutputError("verification.passed must be boolean");
  const rawChecks = array(value.checks, "checks", 1, MAX_LIST);
  const checks: VerificationCheck[] = rawChecks.map((item, index) => {
    const record = recordValue(item, `checks[${index}]`);
    exactFields(record, ["name", "passed", "evidence"], `checks[${index}]`);
    if (typeof record.passed !== "boolean") {
      throw new InvalidWorkerOutputError(`checks[${index}].passed must be boolean`);
    }
    return {
      name: textValue(record.name, `checks[${index}].name`, 500),
      passed: record.passed,
      evidence: textValue(record.evidence, `checks[${index}].evidence`, 4_000),
    };
  });
  const allPassed = checks.every((check) => check.passed);
  if (value.passed !== allPassed) {
    throw new InvalidWorkerOutputError("verification.passed must equal the conjunction of its checks");
  }
  return {
    passed: value.passed,
    summary: textValue(value.summary, "summary", MAX_TEXT),
    checks,
  };
}

export function parseDiagnostic(text: string): DiagnosticResult {
  const value = parseObject(text, "diagnostic");
  exactFields(value, ["summary", "rootCauses", "repairInstructions"], "diagnostic");
  return {
    summary: textValue(value.summary, "summary", MAX_TEXT),
    rootCauses: stringArray(value.rootCauses, "rootCauses", 1, MAX_LIST),
    repairInstructions: stringArray(value.repairInstructions, "repairInstructions", 1, MAX_LIST),
  };
}

export function parseSynthesis(text: string): string {
  const value = parseObject(text, "synthesis");
  exactFields(value, ["summary"], "synthesis");
  return textValue(value.summary, "summary", MAX_SYNTHESIS_TEXT);
}

function parseObject(text: string, label: string): Readonly<Record<string, unknown>> {
  if (text.length > MAX_WORKER_OUTPUT) {
    throw new InvalidWorkerOutputError(`worker output exceeds ${MAX_WORKER_OUTPUT} characters`);
  }
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    throw new InvalidWorkerOutputError(`${label} must be one JSON object`);
  }
  return recordValue(value, label);
}

function exactFields(value: Readonly<Record<string, unknown>>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) throw new InvalidWorkerOutputError(`${label} contains unsupported field ${JSON.stringify(key)}`);
  }
}

function parseWorkItem(value: unknown, field: string, seen: Set<string>): WorkItem {
  const record = recordValue(value, field);
  exactFields(record, ["id", "title", "instruction"], field);
  const id = textValue(record.id, `${field}.id`, 48);
  if (!WORK_ITEM_ID.test(id)) throw new InvalidWorkerOutputError(`invalid work item id ${JSON.stringify(id)}`);
  if (seen.has(id)) throw new InvalidWorkerOutputError(`duplicate work item ${JSON.stringify(id)}`);
  seen.add(id);
  return {
    id,
    title: textValue(record.title, `${field}.title`, 200),
    instruction: textValue(record.instruction, `${field}.instruction`, 2_000),
  };
}

function stringArray(value: unknown, field: string, min: number, max: number): readonly string[] {
  return array(value, field, min, max).map((item, index) => textValue(item, `${field}[${index}]`, 4_000));
}

function array(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new InvalidWorkerOutputError(`${field} must contain ${min} to ${max} items`);
  }
  return value;
}

function textValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidWorkerOutputError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxLength) throw new InvalidWorkerOutputError(`${field} exceeds ${maxLength} characters`);
  return text;
}

function recordValue(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new InvalidWorkerOutputError(`${field} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  MAX_PLAN_CHANGES,
  MAX_PLAN_DEPENDENCIES,
  type ExecutionPlan,
  type PackageScriptCheck,
  type PlanChange,
  type PlanChangeStatus,
} from "./types.ts";

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
const PLAN_ID = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const MAX_TITLE = 200;
const MAX_INSTRUCTION = 8_000;
const MAX_FILE = 400;
const MAX_FILES = 64;
const MAX_REASONS = 16;
const MAX_CHECKS = 16;
const MAX_SCRIPT = 200;
const MAX_TEXT = 4_000;

export class InvalidExecutionPlanError extends Error {
  readonly name = "InvalidExecutionPlanError";
}

export interface PlanTransitionOptions {
  readonly allowIdenticalReplay?: boolean;
}

export function parseExecutionPlan(input: unknown): ExecutionPlan {
  const value = record(input, "execution plan");
  exactFields(value, ["version", "planId", "revision", "changes"], "execution plan");
  if (value.version !== 1) throw new InvalidExecutionPlanError("execution plan version must be 1");
  const planId = text(value.planId, "planId", 128);
  if (!PLAN_ID.test(planId)) throw new InvalidExecutionPlanError("planId has invalid format");
  const revision = integer(value.revision, "revision");
  if (revision < 1) throw new InvalidExecutionPlanError("revision must be a positive integer");
  const rawChanges = boundedArray(value.changes, "changes", 1, MAX_PLAN_CHANGES);
  const seen = new Set<string>();
  const changes = rawChanges.map((item, index) => parseChange(item, `changes[${index}]`, seen));
  const plan: ExecutionPlan = { version: 1, planId, revision, changes };
  validateDependencies(plan);
  return plan;
}

export function validateExecutionPlan(input: unknown): ExecutionPlan {
  return parseExecutionPlan(input);
}

export function validatePlanTransition(
  previousInput: unknown,
  nextInput: unknown,
  options: PlanTransitionOptions = {},
): ExecutionPlan {
  const previous = parseExecutionPlan(previousInput);
  const next = parseExecutionPlan(nextInput);
  if (previous.planId !== next.planId) {
    throw new InvalidExecutionPlanError("plan transition cannot replace planId");
  }
  const identical = JSON.stringify(previous) === JSON.stringify(next);
  if (next.revision <= previous.revision) {
    if (options.allowIdenticalReplay === true && identical) return next;
    throw new InvalidExecutionPlanError("plan revision must advance");
  }
  if (next.changes.length < previous.changes.length) {
    throw new InvalidExecutionPlanError("plan transition must be append-only");
  }
  for (const [index, previousChange] of previous.changes.entries()) {
    if (JSON.stringify(previousChange) !== JSON.stringify(next.changes[index])) {
      throw new InvalidExecutionPlanError(`plan transition cannot redefine change ${JSON.stringify(previousChange.changeId)}`);
    }
  }
  return next;
}

function parseChange(input: unknown, field: string, seen: Set<string>): PlanChange {
  const value = record(input, field);
  exactFields(value, ["changeId", "title", "instruction", "dependsOn", "scope", "risk", "acceptanceChecks", "status"], field);
  const changeId = text(value.changeId, `${field}.changeId`, 48);
  if (!ID.test(changeId)) throw new InvalidExecutionPlanError(`${field}.changeId has invalid format`);
  if (seen.has(changeId)) throw new InvalidExecutionPlanError(`duplicate change ID ${JSON.stringify(changeId)}`);
  seen.add(changeId);
  const dependencies = boundedArray(value.dependsOn, `${field}.dependsOn`, 0, MAX_PLAN_DEPENDENCIES).map((item, index) => text(item, `${field}.dependsOn[${index}]`, 48));
  const scope = record(value.scope, `${field}.scope`);
  exactFields(scope, ["files"], `${field}.scope`);
  const files = boundedArray(scope.files, `${field}.scope.files`, 1, MAX_FILES).map((item, index) =>
    safeScopePath(text(item, `${field}.scope.files[${index}]`, MAX_FILE), `${field}.scope.files[${index}]`));
  const risk = record(value.risk, `${field}.risk`);
  exactFields(risk, ["level", "reasons"], `${field}.risk`);
  if (risk.level !== "low" && risk.level !== "medium" && risk.level !== "high") throw new InvalidExecutionPlanError(`${field}.risk.level is invalid`);
  const reasons = boundedArray(risk.reasons, `${field}.risk.reasons`, 0, MAX_REASONS).map((item, index) => text(item, `${field}.risk.reasons[${index}]`, MAX_TEXT));
  const checks = boundedArray(value.acceptanceChecks, `${field}.acceptanceChecks`, 1, MAX_CHECKS).map((item, index) => parseCheck(item, `${field}.acceptanceChecks[${index}]`));
  const status = value.status === undefined ? "pending" : parseStatus(value.status, `${field}.status`);
  return { changeId, title: text(value.title, `${field}.title`, MAX_TITLE), instruction: text(value.instruction, `${field}.instruction`, MAX_INSTRUCTION), dependsOn: dependencies, scope: { files }, risk: { level: risk.level, reasons }, acceptanceChecks: checks, status };
}

function safeScopePath(path: string, field: string): string {
  if (path === ".") return path;
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.includes("\0")) {
    throw new InvalidExecutionPlanError(`${field} must be a repository-relative path`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new InvalidExecutionPlanError(`${field} must be a normalized repository-relative path`);
  }
  return path;
}

function parseCheck(input: unknown, field: string): PackageScriptCheck {
  const value = record(input, field);
  exactFields(value, ["kind", "script"], field);
  if (value.kind !== "package_script") throw new InvalidExecutionPlanError(`${field}.kind is invalid`);
  return { kind: "package_script", script: text(value.script, `${field}.script`, MAX_SCRIPT) };
}

function parseStatus(value: unknown, field: string): PlanChangeStatus {
  if (value === "pending" || value === "claimed" || value === "applied" || value === "failed") return value;
  throw new InvalidExecutionPlanError(`${field} is invalid`);
}

function validateDependencies(plan: ExecutionPlan): void {
  const changes = new Map(plan.changes.map((change) => [change.changeId, change]));
  for (const change of plan.changes) {
    const seen = new Set<string>();
    for (const dependency of change.dependsOn) {
      if (!changes.has(dependency)) throw new InvalidExecutionPlanError(`change ${JSON.stringify(change.changeId)} depends on unknown change ${JSON.stringify(dependency)}`);
      if (dependency === change.changeId) throw new InvalidExecutionPlanError(`change ${JSON.stringify(change.changeId)} depends on itself`);
      if (seen.has(dependency)) throw new InvalidExecutionPlanError(`change ${JSON.stringify(change.changeId)} repeats dependency ${JSON.stringify(dependency)}`);
      seen.add(dependency);
    }
  }
  const indegree = new Map(plan.changes.map((change) => [change.changeId, change.dependsOn.length]));
  const dependants = new Map(plan.changes.map((change) => [change.changeId, [] as string[]]));
  for (const change of plan.changes) for (const dependency of change.dependsOn) dependants.get(dependency)?.push(change.changeId);
  const ready = plan.changes.filter((change) => change.dependsOn.length === 0).map((change) => change.changeId);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop();
    if (id === undefined) continue;
    visited += 1;
    for (const dependant of dependants.get(id) ?? []) {
      const next = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, next);
      if (next === 0) ready.push(dependant);
    }
  }
  if (visited !== plan.changes.length) throw new InvalidExecutionPlanError("change dependencies contain a cycle");
}

function exactFields(value: Readonly<Record<string, unknown>>, allowed: readonly string[], field: string): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) if (!keys.has(key)) throw new InvalidExecutionPlanError(`${field} contains unsupported field ${JSON.stringify(key)}`);
}

function boundedArray(value: unknown, field: string, min: number, max: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new InvalidExecutionPlanError(`${field} must contain ${min} to ${max} items`);
  return value;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new InvalidExecutionPlanError(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new InvalidExecutionPlanError(`${field} exceeds ${max} characters`);
  return result;
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new InvalidExecutionPlanError(`${field} must be an integer`);
  return value;
}

function record(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new InvalidExecutionPlanError(`${field} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

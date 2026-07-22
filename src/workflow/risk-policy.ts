import { createHash } from "node:crypto";
import { getConfig } from "@langchain/langgraph";
import type {
  ExecutionPlan,
  InterruptBinding,
  InterruptDecision,
  PlanChange,
  ScopedInterrupt,
} from "./types.ts";

const REQUIRED_DECISION_FIELDS = [
  "interruptId",
  "changeId",
  "planId",
  "revision",
  "attempt",
  "scope",
  "allowedScripts",
  "action",
] as const;
const OPTIONAL_BINDING_FIELDS = ["threadId", "checkpointId"] as const;
const MAX_SCOPE_FILES = 64;
const MAX_ALLOWED_SCRIPTS = 16;

export class InvalidInterruptDecisionError extends Error {
  readonly name = "InvalidInterruptDecisionError";
}

export class InterruptDecisionMismatchError extends Error {
  readonly name = "InterruptDecisionMismatchError";
}

export function interruptForChange(
  plan: ExecutionPlan,
  change: PlanChange,
  attempt: number,
  approvalRequired: boolean,
): ScopedInterrupt | undefined {
  if (!approvalRequired && change.risk.level !== "high") return undefined;
  const current = currentInterruptConfig();
  const binding = {
    changeId: change.changeId,
    planId: plan.planId,
    revision: plan.revision,
    attempt,
    scope: { files: [...change.scope.files] },
    allowedScripts: change.acceptanceChecks.map((check) => check.script),
    ...(current.threadId === undefined ? {} : { threadId: current.threadId }),
    ...(current.checkpointId === undefined ? {} : { checkpointId: current.checkpointId }),
  };
  const reasons = change.risk.reasons.length > 0
    ? change.risk.reasons
    : [approvalRequired ? "workflow requires approval before changes" : "high-risk planned change"];
  return { ...binding, interruptId: interruptToken(binding), reasons };
}

export function rebindInterruptToCurrentConfig(interrupt: ScopedInterrupt): ScopedInterrupt {
  const current = currentInterruptConfig();
  if (current.threadId === undefined) {
    throw new InvalidInterruptDecisionError("current workflow thread is unavailable for interrupt rebinding");
  }
  const binding = {
    changeId: interrupt.changeId,
    planId: interrupt.planId,
    revision: interrupt.revision,
    attempt: interrupt.attempt,
    scope: { files: [...interrupt.scope.files] },
    allowedScripts: [...interrupt.allowedScripts],
    threadId: current.threadId,
    ...(current.checkpointId === undefined ? {} : { checkpointId: current.checkpointId }),
  };
  return { ...binding, interruptId: interruptToken(binding), reasons: [...interrupt.reasons] };
}

export function decisionForInterrupt(
  interrupt: ScopedInterrupt,
  action: InterruptDecision["action"],
): InterruptDecision {
  return {
    interruptId: interrupt.interruptId,
    changeId: interrupt.changeId,
    planId: interrupt.planId,
    revision: interrupt.revision,
    attempt: interrupt.attempt,
    scope: { files: [...interrupt.scope.files] },
    allowedScripts: [...interrupt.allowedScripts],
    ...(interrupt.threadId === undefined ? {} : { threadId: interrupt.threadId }),
    ...(interrupt.checkpointId === undefined ? {} : { checkpointId: interrupt.checkpointId }),
    action,
  };
}

export function parseInterruptDecision(value: unknown): InterruptDecision {
  const decision = parseBinding(value, true);
  if (!isRecord(value) || (value.action !== "approve" && value.action !== "reject")) {
    throw new InvalidInterruptDecisionError("interrupt decision action is invalid");
  }
  exactFields(value, [...REQUIRED_DECISION_FIELDS, ...OPTIONAL_BINDING_FIELDS]);
  return { ...decision, action: value.action };
}

export function parseScopedInterrupt(value: unknown): ScopedInterrupt {
  const interrupt = parseBinding(value, false);
  if (!isRecord(value) || !Array.isArray(value.reasons) || value.reasons.length === 0 ||
    !value.reasons.every((reason) => typeof reason === "string")) {
    throw new InvalidInterruptDecisionError("workflow approval interrupt reasons are invalid");
  }
  exactFields(value, [
    "interruptId",
    "changeId",
    "planId",
    "revision",
    "attempt",
    "scope",
    "allowedScripts",
    "reasons",
    ...OPTIONAL_BINDING_FIELDS,
  ]);
  return { ...interrupt, reasons: [...value.reasons] };
}

export function assertDecisionScope(decision: InterruptDecision, interrupt: ScopedInterrupt): void {
  const expected = decisionForInterrupt(interrupt, decision.action);
  const tokenIsValid = interrupt.interruptId === interruptToken(interrupt);
  if (!tokenIsValid || !sameDecision(decision, expected)) {
    throw new InterruptDecisionMismatchError("interrupt decision does not match the pending approval scope");
  }
}

function parseBinding(value: unknown, decision: boolean): InterruptBinding {
  if (!isRecord(value) || typeof value.interruptId !== "string" || typeof value.changeId !== "string" ||
    typeof value.planId !== "string" || !isRecord(value.scope)) {
    throw new InvalidInterruptDecisionError(decision ? "interrupt decision is invalid" : "workflow approval interrupt is invalid");
  }
  const revision = positiveInteger(value.revision, "interrupt revision");
  const attempt = positiveInteger(value.attempt, "interrupt attempt");
  const files = stringArray(value.scope.files, MAX_SCOPE_FILES, "interrupt scope files");
  const allowedScripts = stringArray(value.allowedScripts, MAX_ALLOWED_SCRIPTS, "interrupt allowed scripts");
  const threadId = optionalString(value.threadId, "interrupt threadId");
  const checkpointId = optionalString(value.checkpointId, "interrupt checkpointId");
  return {
    interruptId: value.interruptId,
    changeId: value.changeId,
    planId: value.planId,
    revision,
    attempt,
    scope: { files },
    allowedScripts,
    ...(threadId === undefined ? {} : { threadId }),
    ...(checkpointId === undefined ? {} : { checkpointId }),
  };
}

function interruptToken(binding: Omit<InterruptBinding, "interruptId">): string {
  const payload = JSON.stringify([
    "scoped-interrupt-v1",
    binding.threadId ?? null,
    binding.checkpointId ?? null,
    binding.planId,
    binding.revision,
    binding.changeId,
    binding.attempt,
    binding.scope.files,
    binding.allowedScripts,
  ]);
  return `approval.${createHash("sha256").update(payload).digest("hex")}`;
}

function currentInterruptConfig(): { readonly threadId?: string; readonly checkpointId?: string } {
  const configurable = getConfig()?.configurable;
  const checkpointMap = isRecord(configurable?.checkpoint_map) ? configurable.checkpoint_map : undefined;
  const checkpointNamespace = typeof configurable?.checkpoint_ns === "string" ? configurable.checkpoint_ns : "";
  const mappedCheckpointId = checkpointMap?.[checkpointNamespace];
  const checkpointId = typeof configurable?.checkpoint_id === "string" ? configurable.checkpoint_id : mappedCheckpointId;
  return {
    ...(typeof configurable?.thread_id === "string" ? { threadId: configurable.thread_id } : {}),
    ...(typeof checkpointId === "string" ? { checkpointId } : {}),
  };
}

function sameDecision(left: InterruptDecision, right: InterruptDecision): boolean {
  return left.interruptId === right.interruptId && left.changeId === right.changeId &&
    left.planId === right.planId && left.revision === right.revision && left.attempt === right.attempt &&
    left.threadId === right.threadId && left.checkpointId === right.checkpointId &&
    sameStrings(left.scope.files, right.scope.files) && sameStrings(left.allowedScripts, right.allowedScripts);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringArray(value: unknown, max: number, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max ||
    !value.every((item) => typeof item === "string" && item.length > 0)) {
    throw new InvalidInterruptDecisionError(`${field} are invalid`);
  }
  return [...value];
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new InvalidInterruptDecisionError(`${field} is invalid`);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new InvalidInterruptDecisionError(`${field} is invalid`);
  }
  return value;
}

function exactFields(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const fields = new Set(allowed);
  if (Object.keys(value).some((field) => !fields.has(field))) {
    throw new InvalidInterruptDecisionError("interrupt payload contains unsupported fields");
  }
  if (REQUIRED_DECISION_FIELDS.slice(0, -1).some((field) => !Object.prototype.hasOwnProperty.call(value, field))) {
    throw new InvalidInterruptDecisionError("interrupt payload is missing required fields");
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import {
  MAX_REPAIR_ITERATIONS,
  type CodingWorkflowInput,
  type CompiledWorkflow,
  type DiscoveryResult,
  type ExecutionPlan,
  type Finding,
  type WorkflowPattern,
} from "./types.ts";
import { parseExecutionPlan, validatePlanTransition } from "./execution-plan.ts";
import { parseWorkerObject } from "./parsers.ts";

const MAX_OBJECTIVE_LENGTH = 12_000;
const INPUT_FIELDS = new Set(["objective", "workflow", "maxIterations", "approval"]);
const READ_ONLY_WORDS = /\b(review|audit|analy[sz]e|investigate|explain|research|assess|inspect)\b/i;
const MUTATION_WORDS = /\b(implement|fix|build|create|add|update|migrate|refactor|change|write|ship)\b/i;

export class InvalidWorkflowError extends Error {
  readonly name = "InvalidWorkflowError";
}

export class InvalidDiscoveryEnvelopeError extends Error {
  readonly name = "InvalidDiscoveryEnvelopeError";
}

export interface DiscoveryEnvelope {
  readonly discoveryText: string;
  readonly executionPlan?: ExecutionPlan;
}

export function decodeDiscoveryEnvelope(text: string, previousPlan?: ExecutionPlan): DiscoveryEnvelope {
  const value = parseWorkerObject(text, "discovery");
  if (value.executionPlan === undefined) return { discoveryText: JSON.stringify(value) };
  const allowed = new Set(["workItems", "acceptanceCriteria", "executionPlan"]);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new InvalidDiscoveryEnvelopeError(`discovery contains unsupported field ${JSON.stringify(field)}`);
  }
  const executionPlan = parseExecutionPlan(value.executionPlan);
  return {
    discoveryText: JSON.stringify({
      workItems: value.workItems,
      acceptanceCriteria: value.acceptanceCriteria,
    }),
    executionPlan: previousPlan === undefined
      ? executionPlan
      : validatePlanTransition(previousPlan, executionPlan),
  };
}

export interface AggregatePlanInput {
  readonly threadId: string;
  readonly objective: string;
  readonly discovery: DiscoveryResult;
  readonly findings: readonly Finding[];
}

export function aggregateExecutionPlan(input: AggregatePlanInput): ExecutionPlan {
  const files = input.findings
    .flatMap((finding) => finding.evidence)
    .filter((evidence) => evidence.kind === "file")
    .map((evidence) => evidence.location);
  const risks = input.findings.flatMap((finding) => finding.risks);
  return {
    version: 1,
    planId: `plan-${input.threadId}`.slice(0, 128),
    revision: 1,
    changes: [{
      changeId: "aggregate",
      title: "Aggregate implementation",
      instruction: input.objective,
      dependsOn: [],
      scope: { files: files.length === 0 ? ["."] : [...new Set(files)] },
      risk: { level: risks.length === 0 ? "low" : "high", reasons: [...new Set(risks)] },
      acceptanceChecks: [{ kind: "package_script", script: "test" }],
      status: "pending",
    }],
  };
}

export function isAggregatePlan(plan: ExecutionPlan): boolean {
  return plan.changes.length === 1 && plan.changes[0]?.changeId === "aggregate" &&
    plan.changes[0].title === "Aggregate implementation";
}

export function parseWorkflowInput(value: unknown): CodingWorkflowInput {
  if (!isRecord(value)) throw new InvalidWorkflowError("workflow input must be an object");
  for (const field of Object.keys(value)) {
    if (!INPUT_FIELDS.has(field)) throw new InvalidWorkflowError(`unsupported field ${JSON.stringify(field)}`);
  }

  const objective = boundedText(value.objective, "objective", MAX_OBJECTIVE_LENGTH);
  const workflow = value.workflow;
  if (workflow !== undefined && workflow !== "auto" && workflow !== "delivery" && workflow !== "review") {
    throw new InvalidWorkflowError('workflow must be "auto", "delivery", or "review"');
  }
  const approval = value.approval;
  if (approval !== undefined && approval !== "none" && approval !== "before_changes") {
    throw new InvalidWorkflowError('approval must be "none" or "before_changes"');
  }
  const maxIterations = value.maxIterations;
  if (
    maxIterations !== undefined &&
    (typeof maxIterations !== "number" ||
      !Number.isInteger(maxIterations) ||
      maxIterations < 0 ||
      maxIterations > MAX_REPAIR_ITERATIONS)
  ) {
    throw new InvalidWorkflowError(`maxIterations must be an integer from 0 to ${MAX_REPAIR_ITERATIONS}`);
  }

  return {
    objective,
    ...(workflow === undefined ? {} : { workflow }),
    ...(approval === undefined ? {} : { approval }),
    ...(typeof maxIterations === "number" ? { maxIterations } : {}),
  };
}

export function compileWorkflow(input: CodingWorkflowInput): CompiledWorkflow {
  const parsed = parseWorkflowInput(input);
  const pattern = selectPattern(parsed.objective, parsed.workflow ?? "auto");
  const maxIterations = pattern === "review" ? 0 : (parsed.maxIterations ?? 2);
  return {
    objective: parsed.objective,
    pattern,
    maxIterations,
    recursionLimit: workflowRecursionLimit(maxIterations),
  };
}

export function workflowRecursionLimit(maxIterations: number): number {
  return Math.min(32, 12 + maxIterations * 4);
}

function selectPattern(objective: string, requested: "auto" | WorkflowPattern): WorkflowPattern {
  if (requested !== "auto") return requested;
  if (READ_ONLY_WORDS.test(objective) && !MUTATION_WORDS.test(objective)) return "review";
  return "delivery";
}

function boundedText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidWorkflowError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (text.length > maxLength) throw new InvalidWorkflowError(`${field} exceeds ${maxLength} characters`);
  return text;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ProgressReporter, TaskExecutor } from "../types.ts";

export const MAX_WORK_ITEMS = 16;
export const MAX_REPAIR_ITERATIONS = 5;

export type WorkflowPattern = "delivery" | "review";
export type ApprovalPolicy = "none" | "before_changes";
export type WorkflowStatus = "running" | "awaiting_approval" | "completed" | "needs_attention";
export type WorkflowPhase =
  | "classified"
  | "discovered"
  | "analyzed"
  | "implemented"
  | "verified"
  | "diagnosed"
  | "repaired"
  | "synthesized"
  | "escalated";

export interface CodingWorkflowInput {
  readonly objective: string;
  readonly workflow?: "auto" | WorkflowPattern;
  readonly maxIterations?: number;
  readonly approval?: ApprovalPolicy;
}

export interface CompiledWorkflow {
  readonly objective: string;
  readonly pattern: WorkflowPattern;
  readonly maxIterations: number;
  readonly recursionLimit: number;
}

export interface WorkItem {
  readonly id: string;
  readonly title: string;
  readonly instruction: string;
}

export interface DiscoveryResult {
  readonly workItems: readonly WorkItem[];
  readonly acceptanceCriteria: readonly string[];
}

export interface FindingEvidence {
  readonly kind: "file" | "test" | "runtime" | "documentation" | "other";
  readonly location: string;
  readonly detail: string;
}

export interface Finding {
  readonly workItemId: string;
  readonly summary: string;
  readonly evidence: readonly FindingEvidence[];
  readonly risks: readonly string[];
  readonly discoveredWorkItems: readonly WorkItem[];
}

export interface ChangeSet {
  readonly kind: "implementation" | "repair";
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly evidence: readonly string[];
  readonly unresolvedRisks: readonly string[];
}

export interface VerificationCheck {
  readonly name: string;
  readonly passed: boolean;
  readonly evidence: string;
}

export interface VerificationResult {
  readonly passed: boolean;
  readonly summary: string;
  readonly checks: readonly VerificationCheck[];
}

export interface DiagnosticResult {
  readonly summary: string;
  readonly rootCauses: readonly string[];
  readonly repairInstructions: readonly string[];
}

export interface WorkflowTraceEvent {
  readonly node:
    | "classify"
    | "discover"
    | "specialist"
    | "replan"
    | "implement"
    | "verify"
    | "diagnose"
    | "repair"
    | "synthesize"
    | "escalate";
  readonly iteration: number;
  readonly workItemId?: string;
  readonly route?: "implement" | "synthesize" | "diagnose" | "escalate" | "verify";
}

export interface CodingWorkflowResult {
  readonly threadId: string;
  readonly objective: string;
  readonly pattern: WorkflowPattern;
  readonly status: Exclude<WorkflowStatus, "running" | "awaiting_approval">;
  readonly phase: WorkflowPhase;
  readonly workItems: readonly WorkItem[];
  readonly findings: readonly Finding[];
  readonly changes: readonly ChangeSet[];
  readonly verification?: VerificationResult;
  readonly unresolvedRisks: readonly string[];
  readonly iteration: number;
  readonly summary: string;
  readonly trace: readonly WorkflowTraceEvent[];
}

export interface ApprovalRequiredResult {
  readonly threadId: string;
  readonly objective: string;
  readonly pattern: WorkflowPattern;
  readonly status: "awaiting_approval";
  readonly phase: "analyzed";
  readonly workItems: readonly WorkItem[];
  readonly findings: readonly Finding[];
  readonly trace: readonly WorkflowTraceEvent[];
  readonly verification?: VerificationResult;
  readonly unresolvedRisks?: readonly string[];
  readonly iteration?: number;
  readonly summary?: string;
}

export type CodingRunResult = CodingWorkflowResult | ApprovalRequiredResult;

export interface CodingRunOptions {
  readonly threadId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressReporter;
  readonly checkpointer?: BaseCheckpointSaver;
  readonly retainCheckpoint?: boolean;
  readonly requireApproval?: boolean;
  readonly nodeTimeoutMs?: number;
}

export interface ResumeRunOptions extends Omit<CodingRunOptions, "threadId" | "requireApproval"> {
  readonly approved?: boolean;
}

export interface WorkflowRuntimeDependencies {
  readonly executor: TaskExecutor;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressReporter;
  readonly nodeTimeoutMs: number;
}

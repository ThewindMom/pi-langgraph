import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ArtifactRef, HostEvidence } from "../evidence/types.ts";
import type { ProgressReporter, TaskExecutor } from "../types.ts";
import type { WorkflowEvent } from "./stream-events.ts";

export const MAX_WORK_ITEMS = 16;
export const MAX_REPAIR_ITERATIONS = 5;
export const MAX_PLAN_CHANGES = 16;
export const MAX_PLAN_DEPENDENCIES = 16;

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

export type PlanChangeStatus = "pending" | "claimed" | "applied" | "failed";

export interface PlanScope {
  readonly files: readonly string[];
}

export interface PlanRisk {
  readonly level: "low" | "medium" | "high";
  readonly reasons: readonly string[];
}

export interface PackageScriptCheck {
  readonly kind: "package_script";
  readonly script: string;
}

export interface PlanChange {
  readonly changeId: string;
  readonly title: string;
  readonly instruction: string;
  readonly dependsOn: readonly string[];
  readonly scope: PlanScope;
  readonly risk: PlanRisk;
  readonly acceptanceChecks: readonly PackageScriptCheck[];
  readonly status: PlanChangeStatus;
}

export interface ExecutionPlan {
  readonly version: 1;
  readonly planId: string;
  readonly revision: number;
  readonly changes: readonly PlanChange[];
}

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
  readonly executionPlan?: ExecutionPlan;
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

export type ChangeExecutionStatus = "pending" | "running" | "passed" | "failed" | "needs_attention";

export interface ChangeResult {
  readonly changeId: string;
  readonly status: ChangeExecutionStatus;
  readonly attempt: number;
  readonly evidenceRefs: readonly ArtifactRef[];
  readonly change?: ChangeSet;
  readonly verification?: VerificationResult;
}

export type InterruptBinding = {
  readonly interruptId: string;
  readonly changeId: string;
  readonly planId: string;
  readonly revision: number;
  readonly attempt: number;
  readonly scope: PlanScope;
  readonly allowedScripts: readonly string[];
  readonly threadId?: string;
  readonly checkpointId?: string;
};

export type ScopedInterrupt = InterruptBinding & {
  readonly reasons: readonly string[];
};

export type InterruptDecision = InterruptBinding & {
  readonly action: "approve" | "reject";
};

export interface HostEvidenceExecutor {
  defaultIntegrationScripts?(): Promise<readonly string[]>;
  runPackageScript(script: string, signal?: AbortSignal): Promise<HostEvidence>;
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
  readonly plan?: ExecutionPlan;
  readonly changeResults: readonly ChangeResult[];
  readonly evidenceRefs: readonly ArtifactRef[];
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
  readonly interrupt: ScopedInterrupt;
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
  readonly evidenceRunner?: HostEvidenceExecutor;
  readonly onEvent?: (event: WorkflowEvent) => void;
}

export interface ResumeRunOptions extends Omit<CodingRunOptions, "threadId" | "requireApproval"> {
  readonly approved?: boolean;
  readonly decision?: InterruptDecision;
  readonly checkpointId?: string;
}

export interface WorkflowRuntimeDependencies {
  readonly executor: TaskExecutor;
  readonly signal?: AbortSignal;
  readonly onProgress?: ProgressReporter;
  readonly nodeTimeoutMs: number;
  readonly evidenceRunner?: HostEvidenceExecutor;
}

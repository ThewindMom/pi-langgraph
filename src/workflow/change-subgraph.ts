import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { ArtifactRef } from "../evidence/types.ts";
import type { MutationExecution, MutationOperation } from "../persistence/mutation-journal.ts";
import type { OrchestrationTask } from "../types.ts";
import { isAggregatePlan } from "./compiler.ts";
import { mutationChange } from "./mutation-reconciliation.ts";
import { assertDecisionScope, parseInterruptDecision, rebindInterruptToCurrentConfig } from "./risk-policy.ts";
import type {
  ChangeResult,
  ChangeSet,
  ExecutionPlan,
  Finding,
  HostEvidenceExecutor,
  PlanChange,
  ScopedInterrupt,
  VerificationCheck,
  VerificationResult,
  WorkflowPhase,
  WorkflowStatus,
  WorkflowTraceEvent,
} from "./types.ts";
import { task, workerPrompt } from "./worker-prompts.ts";

const ChangeState = Annotation.Root({
  objective: Annotation<string>,
  plan: Annotation<ExecutionPlan>,
  change: Annotation<PlanChange>,
  current: Annotation<ChangeResult>,
  previousResult: Annotation<ChangeResult | undefined>,
  findings: Annotation<readonly Finding[]>,
  hadGlobalChange: Annotation<boolean>,
  interrupt: Annotation<ScopedInterrupt | undefined>,
  approvalOutcome: Annotation<"approved" | "rejected" | undefined>,
  changes: Annotation<readonly ChangeSet[]>({ default: () => [], reducer: (left, right) => [...left, ...right] }),
  changeResults: Annotation<readonly ChangeResult[]>({ default: () => [], reducer: (left, right) => [...left, ...right] }),
  evidenceRefs: Annotation<readonly ArtifactRef[]>({ default: () => [], reducer: (left, right) => [...left, ...right] }),
  unresolvedRisks: Annotation<readonly string[]>({ default: () => [], reducer: (left, right) => [...left, ...right] }),
  phase: Annotation<WorkflowPhase>,
  iteration: Annotation<number>,
  trace: Annotation<readonly WorkflowTraceEvent[]>({ default: () => [], reducer: (left, right) => [...left, ...right] }),
  status: Annotation<WorkflowStatus>,
});

const ChangeOutput = Annotation.Root({
  interrupt: Annotation<ScopedInterrupt | undefined>,
  changes: Annotation<readonly ChangeSet[]>,
  changeResults: Annotation<readonly ChangeResult[]>,
  evidenceRefs: Annotation<readonly ArtifactRef[]>,
  unresolvedRisks: Annotation<readonly string[]>,
  phase: Annotation<WorkflowPhase>,
  iteration: Annotation<number>,
  trace: Annotation<readonly WorkflowTraceEvent[]>,
  status: Annotation<WorkflowStatus>,
});

type ChangeStateValue = typeof ChangeState.State;
type ExecuteMutation = (
  task: OrchestrationTask,
  objective: string,
  operation: MutationOperation,
) => Promise<MutationExecution>;

export interface ChangeSubgraphDependencies {
  readonly executeMutation: ExecuteMutation;
  readonly evidenceRunner?: HostEvidenceExecutor;
  readonly signal?: AbortSignal;
  readonly threadId: string;
  readonly nodeTimeout: number;
}

export function compileChangeSubgraph(dependencies: ChangeSubgraphDependencies) {
  return new StateGraph({ stateSchema: ChangeState, output: ChangeOutput })
    .addNode("approve", approvalNode)
    .addNode("mutate", mutationNode(dependencies), { timeout: dependencies.nodeTimeout })
    .addNode("evidence", evidenceNode(dependencies))
    .addEdge(START, "approve")
    .addConditionalEdges("approve", routeApproval)
    .addEdge("mutate", "evidence")
    .addEdge("evidence", END)
    .compile({ name: "planned-change" });
}

function approvalNode(state: ChangeStateValue) {
  const persisted = state.interrupt;
  if (persisted === undefined) return { approvalOutcome: "approved" as const, status: "running" as const };
  const pending = rebindInterruptToCurrentConfig(persisted);
  const decision = parseInterruptDecision(interrupt<typeof pending, unknown>(pending));
  assertDecisionScope(decision, pending);
  switch (decision.action) {
    case "approve":
      return { interrupt: undefined, approvalOutcome: "approved" as const, status: "running" as const };
    case "reject":
      return {
      interrupt: undefined,
      approvalOutcome: "rejected" as const,
      status: "running" as const,
      changeResults: [{ ...state.current, status: "needs_attention" as const }],
      };
    default:
      return assertNever(decision.action);
  }
}

function routeApproval(state: ChangeStateValue): "mutate" | typeof END {
  switch (state.approvalOutcome) {
    case "approved":
      return "mutate";
    case "rejected":
      return END;
    case undefined:
      throw new Error("approval node completed without an outcome");
    default:
      return assertNever(state.approvalOutcome);
  }
}

function mutationNode(dependencies: ChangeSubgraphDependencies) {
  return async (state: ChangeStateValue) => {
    const kind = state.current.attempt === 1 ? "implementation" as const : "repair" as const;
    const operationKind = kind === "implementation" ? "implement" as const : "repair" as const;
    const aggregate = isAggregatePlan(state.plan);
    const operation: MutationOperation = aggregate
      ? { kind: operationKind, iteration: state.current.attempt - 1 }
      : {
          kind: operationKind,
          iteration: state.current.attempt - 1,
          workspaceId: dependencies.threadId,
          planId: state.plan.planId,
          changeId: state.change.changeId,
          attempt: state.current.attempt,
        };
    const taskId = aggregate ? operationKind : `${operationKind}_${state.change.changeId}`;
    const allowedFiles = aggregate ? ["."] : state.change.scope.files;
    const execution = await dependencies.executeMutation(
      { ...task(taskId, mutationPrompt(state, kind)), allowedFiles },
      state.objective,
      operation,
    );
    const reported = mutationChange(execution, kind, state.current.attempt - 1);
    assertReportedScope(reported.filesChanged, allowedFiles);
    const includeGlobal = aggregate || !state.hadGlobalChange;
    return {
      current: { ...state.current, change: reported },
      ...(includeGlobal ? { changes: [reported] } : {}),
      unresolvedRisks: reported.unresolvedRisks,
      phase: aggregate && kind === "repair" ? "repaired" as const : "implemented" as const,
      ...(aggregate && kind === "repair" ? { iteration: state.current.attempt - 1 } : {}),
      trace: [{ node: operationKind, iteration: state.current.attempt - 1 }],
    };
  };
}

function assertReportedScope(files: readonly string[], allowedFiles: readonly string[]): void {
  if (allowedFiles.includes(".")) return;
  const allowed = new Set(allowedFiles);
  const unexpected = files.filter((file) => !allowed.has(file));
  if (unexpected.length > 0) {
    throw new Error(`Pi worker reported files outside its planned mutation scope: ${unexpected.join(", ")}`);
  }
}

function evidenceNode(dependencies: ChangeSubgraphDependencies) {
  return async (state: ChangeStateValue) => {
    const acceptanceChecks = localAcceptanceChecks(state);
    if (acceptanceChecks.length > 0 && dependencies.evidenceRunner === undefined) {
      throw new Error("planned acceptance checks require a host evidence runner");
    }
    const checks: VerificationCheck[] = [];
    const refs: ArtifactRef[] = [];
    for (const acceptance of acceptanceChecks) {
      const evidence = await dependencies.evidenceRunner?.runPackageScript(acceptance.script, dependencies.signal);
      if (evidence === undefined) throw new Error("host evidence runner is unavailable");
      refs.push(evidence.stdout, evidence.stderr);
      checks.push({
        name: `package:${acceptance.script}`,
        passed: evidence.passed,
        evidence: `exit=${evidence.exitCode ?? "signal"};stdout=${evidence.stdout.digest};stderr=${evidence.stderr.digest}`,
      });
    }
    const passed = checks.every((check) => check.passed);
    const verification: VerificationResult = {
      passed,
      summary: passed ? "planned acceptance checks passed" : "planned acceptance checks failed",
      checks: checks.length === 0
        ? [{ name: "integration-deferred", passed: true, evidence: "final integration verification required" }]
        : checks,
    };
    return {
      changeResults: [{ ...state.current, status: passed ? "passed" as const : "failed" as const, evidenceRefs: refs, verification }],
      evidenceRefs: refs,
      interrupt: undefined,
      status: "running" as const,
    };
  };
}

function localAcceptanceChecks(state: ChangeStateValue) {
  if (isAggregatePlan(state.plan)) return [];
  const currentIndex = state.plan.changes.findIndex((change) => change.changeId === state.change.changeId);
  const laterScripts = new Set(state.plan.changes
    .slice(currentIndex + 1)
    .flatMap((change) => change.acceptanceChecks.map((check) => check.script)));
  return state.change.acceptanceChecks.filter((check) => !laterScripts.has(check.script));
}

function mutationPrompt(state: ChangeStateValue, kind: "implementation" | "repair"): string {
  return workerPrompt(kind, state.objective, {
    change: state.change,
    findings: state.findings,
    previousResult: state.previousResult,
    instruction: `${kind === "repair" ? "Repair only this failed planned change." : state.change.instruction} Report unresolved risks only within this change's authorized scope after your work. Do not report pending or unmodified sibling plan changes as this change's risks.`,
    requiredOutput: {
      summary: "string",
      filesChanged: ["relative path"],
      evidence: ["observed fact"],
      unresolvedRisks: ["string"],
    },
  });
}

function assertNever(value: never): never {
  throw new Error(`unexpected approval outcome ${JSON.stringify(value)}`);
}

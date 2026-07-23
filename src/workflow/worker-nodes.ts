import { Command } from "@langchain/langgraph";
import type { WorkerTask } from "../types.ts";
import type { MutationExecution, MutationOperation } from "../persistence/mutation-journal.ts";
import {
  InvalidWorkerOutputError,
  parseDiagnostic,
  parseFinding,
  parseSynthesis,
  parseVerification,
} from "./parsers.ts";
import { executeDiscovery } from "./discovery-worker.ts";
import { mutationChange } from "./mutation-reconciliation.ts";
import { task, workerPrompt } from "./worker-prompts.ts";
import type { SpecialistStateValue, WorkflowStateValue } from "./workflow-state.ts";
import { isAggregatePlan } from "./compiler.ts";
import { hostIntegrationVerification } from "./host-verification.ts";
import type { HostEvidenceExecutor } from "./types.ts";

type ExecuteWorker = (task: WorkerTask, objective: string) => Promise<string>;
type ExecuteMutation = (
  task: WorkerTask,
  objective: string,
  operation: MutationOperation,
) => Promise<MutationExecution>;

export function createSpecialistNode(execute: ExecuteWorker) {
  return async (state: SpecialistStateValue) => {
    const workItem = state.currentWorkItem;
    if (workItem === undefined) throw new InvalidWorkerOutputError("specialist work item is missing");
    const output = await execute(
      task(
        `specialist_${workItem.id}`,
        workerPrompt("specialist", state.objective, {
          workItem,
          requiredOutput: {
            summary: "non-empty string",
            evidence: [{ kind: "file|test|runtime|documentation|other", location: "string", detail: "string" }],
            risks: ["string"],
            discoveredWorkItems: [{ id: "lexical-id", title: "string", instruction: "string" }],
          },
        }),
      ),
      state.objective,
    );
    return {
      findings: [parseFinding(output, workItem.id)],
      trace: [{ node: "specialist" as const, workItemId: workItem.id, iteration: state.iteration }],
    };
  };
}

export function createDiscoverNode(execute: ExecuteWorker) {
  return async (state: WorkflowStateValue) => {
    const result = await executeDiscovery(execute, state.objective, state.plan);
    return {
      workItems: result.discovery.workItems,
      acceptanceCriteria: result.discovery.acceptanceCriteria,
      ...(result.plan === undefined ? {} : { plan: result.plan }),
      phase: "discovered" as const,
      trace: [{ node: "discover" as const, iteration: state.iteration }],
    };
  };
}

export function createImplementNode(execute: ExecuteMutation) {
  return async (state: WorkflowStateValue) => {
    const execution = await execute(
      task(
        "implement",
        workerPrompt("implementation", state.objective, {
          findings: state.findings,
          acceptanceCriteria: state.acceptanceCriteria,
          instruction:
            "Implement the objective in the current repository. Keep mutation in this worker, run focused checks when useful, and report only observed changes.",
          requiredOutput: {
            summary: "string",
            filesChanged: ["relative path"],
            evidence: ["observed fact"],
            unresolvedRisks: ["string"],
          },
        }),
      ),
      state.objective,
      { kind: "implement", iteration: 0 },
    );
    const change = mutationChange(execution, "implementation", 0);
    return {
      changes: [change],
      unresolvedRisks: change.unresolvedRisks,
      phase: "implemented" as const,
      trace: [{ node: "implement" as const, iteration: state.iteration }],
    };
  };
}

export function createVerifyNode(
  execute: ExecuteWorker,
  evidenceRunner?: HostEvidenceExecutor,
  signal?: AbortSignal,
) {
  return async (state: WorkflowStateValue) => {
    const output = await execute(
      task(
        "verify",
        workerPrompt("verification", state.objective, {
          acceptanceCriteria: state.acceptanceCriteria,
          changes: state.changes,
          instruction:
            "Inspect the actual workspace and execute relevant deterministic tests, type checks, builds, or runtime probes. Never infer a pass from a change description.",
          requiredOutput: {
            passed: "boolean equal to every check passing",
            summary: "string",
            checks: [{ name: "string", passed: "boolean", evidence: "command/result or direct observation" }],
          },
        }),
      ),
      state.objective,
    );
    parseVerification(output);
    const host = await hostIntegrationVerification(evidenceRunner, signal);
    const verification = host.verification;
    const aggregate = state.plan === undefined || isAggregatePlan(state.plan);
    const route = verification.passed
      ? "synthesize"
      : aggregate && state.iteration < state.maxIterations
        ? "diagnose"
        : "escalate";
    return new Command({
      update: {
        verification,
        evidenceRefs: host.refs,
        phase: "verified" as const,
        trace: [{ node: "verify" as const, route, iteration: state.iteration }],
      },
      goto: route,
    });
  };
}

export function createDiagnoseNode(execute: ExecuteWorker) {
  return async (state: WorkflowStateValue) => {
    const output = await execute(
      task(
        "diagnose",
        workerPrompt("diagnosis", state.objective, {
          verification: state.verification,
          changes: state.changes,
          instruction: "Diagnose the failed verification without editing files. Base every cause on the reported evidence.",
          requiredOutput: {
            summary: "string",
            rootCauses: ["string"],
            repairInstructions: ["bounded actionable string"],
          },
        }),
      ),
      state.objective,
    );
    return {
      diagnostic: parseDiagnostic(output),
      phase: "diagnosed" as const,
      trace: [{ node: "diagnose" as const, iteration: state.iteration }],
    };
  };
}

export function createRepairNode(execute: ExecuteMutation) {
  return async (state: WorkflowStateValue) => {
    const iteration = state.iteration + 1;
    const execution = await execute(
      task(
        "repair",
        workerPrompt("repair", state.objective, {
          diagnostic: state.diagnostic,
          previousVerification: state.verification,
          instruction: "Apply only the diagnosed repair in the current repository, then report observed changes.",
          requiredOutput: {
            summary: "string",
            filesChanged: ["relative path"],
            evidence: ["observed fact"],
            unresolvedRisks: ["string"],
          },
        }),
      ),
      state.objective,
      { kind: "repair", iteration },
    );
    const change = mutationChange(execution, "repair", iteration);
    return {
      changes: [change],
      unresolvedRisks: change.unresolvedRisks,
      iteration,
      phase: "repaired" as const,
      trace: [{ node: "repair" as const, route: "verify" as const, iteration }],
    };
  };
}

export function createSynthesizeNode(execute: ExecuteWorker) {
  return async (state: WorkflowStateValue) => {
    const output = await execute(
      task(
        "synthesize",
        workerPrompt("evidence synthesis", state.objective, {
          pattern: state.pattern,
          preMutationFindings: state.findings,
          changes: state.changes,
          verification: state.verification,
          unresolvedRisks: state.unresolvedRisks,
          instruction: "Summarize only the supplied structured evidence. Pre-mutation findings describe the initial workspace and must not override later change evidence or trusted host verification. A passing host verification establishes the tested post-mutation behavior. Do not claim unreported checks or changes.",
          requiredOutput: { summary: "concise evidence-based string under 6000 characters" },
        }),
      ),
      state.objective,
    );
    return {
      summary: parseSynthesis(output),
      phase: "synthesized" as const,
      status: "completed" as const,
      trace: [{ node: "synthesize" as const, iteration: state.iteration }],
    };
  };
}

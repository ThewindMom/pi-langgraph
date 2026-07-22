import { Command } from "@langchain/langgraph";
import type { OrchestrationTask } from "../types.ts";
import {
  InvalidWorkerOutputError,
  parseChangeSet,
  parseDiagnostic,
  parseDiscovery,
  parseFinding,
  parseSynthesis,
  parseVerification,
} from "./parsers.ts";
import { task, workerPrompt } from "./worker-prompts.ts";
import type { SpecialistStateValue, WorkflowStateValue } from "./workflow-state.ts";

type ExecuteWorker = (task: OrchestrationTask, objective: string) => Promise<string>;

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
    const output = await execute(
      task(
        "discover",
        workerPrompt("discovery", state.objective, {
          instruction:
            "Inspect the repository and decompose the objective into independent read-only analysis units. Do not edit files.",
          requiredOutput: {
            workItems: [{ id: "lexical-id", title: "string", instruction: "self-contained string" }],
            acceptanceCriteria: ["observable criterion"],
          },
        }),
      ),
      state.objective,
    );
    const discovery = parseDiscovery(output);
    return {
      workItems: discovery.workItems,
      acceptanceCriteria: discovery.acceptanceCriteria,
      phase: "discovered" as const,
      trace: [{ node: "discover" as const, iteration: state.iteration }],
    };
  };
}

export function createImplementNode(execute: ExecuteWorker) {
  return async (state: WorkflowStateValue) => {
    const output = await execute(
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
    );
    const change = parseChangeSet(output, "implementation");
    return {
      changes: [change],
      unresolvedRisks: change.unresolvedRisks,
      phase: "implemented" as const,
      trace: [{ node: "implement" as const, iteration: state.iteration }],
    };
  };
}

export function createVerifyNode(execute: ExecuteWorker) {
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
    const verification = parseVerification(output);
    const route = verification.passed
      ? "synthesize"
      : state.iteration < state.maxIterations
        ? "diagnose"
        : "escalate";
    return new Command({
      update: {
        verification,
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

export function createRepairNode(execute: ExecuteWorker) {
  return async (state: WorkflowStateValue) => {
    const output = await execute(
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
    );
    const change = parseChangeSet(output, "repair");
    const iteration = state.iteration + 1;
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
          findings: state.findings,
          changes: state.changes,
          verification: state.verification,
          unresolvedRisks: state.unresolvedRisks,
          instruction: "Summarize only the supplied structured evidence. Do not claim unreported checks or changes.",
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

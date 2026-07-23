import type { WorkerTask } from "../types.ts";
import { decodeDiscoveryEnvelope, InvalidDiscoveryEnvelopeError } from "./compiler.ts";
import { InvalidExecutionPlanError } from "./execution-plan.ts";
import { InvalidWorkerOutputError, parseDiscovery } from "./parsers.ts";
import { task, workerPrompt } from "./worker-prompts.ts";
import type { DiscoveryResult, ExecutionPlan } from "./types.ts";

type ExecuteWorker = (task: WorkerTask, objective: string) => Promise<string>;

const outputShape = {
  workItems: [{ id: "lexical-id", title: "string", instruction: "self-contained string" }],
  acceptanceCriteria: ["observable criterion"],
  executionPlan: {
    version: 1,
    planId: "stable-lexical-id",
    revision: 1,
    changes: [{
      changeId: "lexical-id",
      title: "string",
      instruction: "self-contained string",
      dependsOn: ["earlier-change-id"],
      scope: { files: ["relative/path"] },
      risk: { level: "low|medium|high", reasons: ["specific reason"] },
      acceptanceChecks: [{ kind: "package_script", script: "existing-script-name" }],
      status: "pending",
    }],
  },
} as const;

export async function executeDiscovery(
  execute: ExecuteWorker,
  objective: string,
  previousPlan?: ExecutionPlan,
): Promise<Readonly<{ discovery: DiscoveryResult; plan?: ExecutionPlan }>> {
  const initial = await execute(task("discover", discoveryPrompt(objective)), objective);
  try {
    return parse(initial, previousPlan);
  } catch (error) {
    if (!isFormatError(error)) throw error;
    const repaired = await execute(task("discover_format_repair", workerPrompt("discovery format repair", objective, {
      instruction: "Correct only the JSON structure. Preserve valid repository findings. Do not inspect or edit files.",
      validationError: error.message,
      invalidOutput: initial,
      requiredOutput: outputShape,
    })), objective);
    return parse(repaired, previousPlan);
  }
}

function discoveryPrompt(objective: string): string {
  return workerPrompt("discovery", objective, {
    instruction: "Inspect the repository and decompose the objective into independent read-only analysis units. Do not edit files.",
    requiredOutput: outputShape,
  });
}

function parse(text: string, previousPlan?: ExecutionPlan): Readonly<{ discovery: DiscoveryResult; plan?: ExecutionPlan }> {
  const envelope = decodeDiscoveryEnvelope(text, previousPlan);
  const discovery = parseDiscovery(envelope.discoveryText);
  return { discovery, ...(envelope.executionPlan === undefined ? {} : { plan: envelope.executionPlan }) };
}

function isFormatError(error: unknown): error is Error {
  return error instanceof InvalidWorkerOutputError ||
    error instanceof InvalidExecutionPlanError ||
    error instanceof InvalidDiscoveryEnvelopeError;
}

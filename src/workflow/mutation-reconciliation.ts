import type { MutationExecution } from "../persistence/mutation-journal.ts";
import { InvalidWorkerOutputError, parseChangeSet } from "./parsers.ts";
import type { ChangeSet } from "./types.ts";

export function mutationChange(
  execution: MutationExecution,
  kind: ChangeSet["kind"],
  iteration: number,
): ChangeSet {
  if (execution.status === "completed") {
    try {
      return parseChangeSet(execution.output, kind);
    } catch (error) {
      if (!(error instanceof InvalidWorkerOutputError)) throw error;
      return reconciliationChange(kind, iteration, "invalid");
    }
  }
  return reconciliationChange(kind, iteration, "indeterminate");
}

function reconciliationChange(
  kind: ChangeSet["kind"],
  iteration: number,
  cause: "invalid" | "indeterminate",
): ChangeSet {
  const operation = operationName(kind, iteration);
  const invalid = cause === "invalid";
  return {
    kind,
    summary: `Mutation ${operation} ${invalid ? "returned an invalid change report" : "has an indeterminate result"}; it was not invoked again.`,
    filesChanged: [],
    evidence: [invalid
      ? `Durable mutation result ${operation} could not be validated.`
      : `Durable mutation claim ${operation} was started without a recorded result.`],
    unresolvedRisks: ["The verifier must reconcile the actual workspace before further mutation."],
  };
}

function operationName(kind: ChangeSet["kind"], iteration: number): string {
  return `${kind === "implementation" ? "implement" : "repair"}:${iteration}`;
}

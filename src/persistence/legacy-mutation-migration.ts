import { mutationKey, type SerializedMutationEntry } from "./mutation-journal.ts";

export function migrateLegacyMutationJournal(
  workflowStates: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): Record<string, SerializedMutationEntry> {
  const entries: Record<string, SerializedMutationEntry> = Object.create(null);
  const latestId = [...workflowStates.keys()].sort().at(-1);
  if (latestId === undefined) return entries;
  const state = workflowStates.get(latestId);
  if (state?.pattern !== "delivery" || state.status !== "running") return entries;
  const iteration = state.iteration;
  const maxIterations = state.maxIterations;
  if (state.phase === "analyzed") {
    entries[mutationKey({ kind: "implement", iteration: 0 })] = { status: "started" };
  } else if (
    state.phase === "diagnosed" &&
    typeof iteration === "number" &&
    Number.isSafeInteger(iteration) &&
    typeof maxIterations === "number" &&
    iteration < maxIterations
  ) {
    if (iteration >= 0) {
      entries[mutationKey({ kind: "repair", iteration: iteration + 1 })] = { status: "started" };
    }
  }
  return entries;
}

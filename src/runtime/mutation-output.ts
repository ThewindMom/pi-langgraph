import { RepositoryIsolationError } from "../repository/mutation-scope.ts";
import { parseChangeSet } from "../workflow/parsers.ts";

export function validateMutationOutput(
  output: string,
  changedPaths: readonly string[],
  taskId: string,
  allowedFiles: readonly string[] | undefined,
): void {
  const kind = taskId === "repair" || taskId.startsWith("repair_") ? "repair" : "implementation";
  const reported = parseChangeSet(output, kind).filesChanged;
  const uniqueReported = new Set(reported);
  if (uniqueReported.size !== reported.length || reported.some((path) => !isRepositoryPath(path))) {
    throw new RepositoryIsolationError("scope", "Pi worker reported invalid changed file paths");
  }
  const allowAll = allowedFiles?.includes(".") === true;
  const allowed = new Set(allowedFiles ?? []);
  const outsideScope = reported.filter((path) => !allowAll && !allowed.has(path));
  if (outsideScope.length > 0) {
    throw new RepositoryIsolationError(
      "scope",
      `Pi worker reported files outside its planned scope: ${outsideScope.sort().join(", ")}`,
    );
  }
  const actual = new Set(changedPaths);
  const omitted = changedPaths.filter((path) => !uniqueReported.has(path));
  const unchanged = reported.filter((path) => !actual.has(path));
  if (omitted.length > 0 || unchanged.length > 0) {
    throw new RepositoryIsolationError(
      "scope",
      `Pi worker change report did not match isolated repository changes: omitted [${omitted.join(", ")}], unchanged [${unchanged.join(", ")}]`,
    );
  }
}

function isRepositoryPath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

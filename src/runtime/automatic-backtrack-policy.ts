import {
  classifyBacktrackTrigger,
  type BacktrackPolicyDecision,
} from "../workflow/backtrack-policy.ts";
import type { CodingWorkflowResult } from "../workflow/types.ts";

export function isStructuredFailedDelivery(
  result: CodingWorkflowResult,
): boolean {
  return (
    result.status === "needs_attention" &&
    result.verification?.passed === false &&
    result.trace.some((event) => event.node === "diagnose")
  );
}

export function automaticBacktrackDecision(
  result: CodingWorkflowResult,
): BacktrackPolicyDecision {
  const failedChecks = checkFailures(result);
  const verificationCount = result.trace.filter((event) => event.node === "verify").length;
  return classifyBacktrackTrigger({
    failedChecks,
    repeatedFailureSignature: verificationCount > 1,
    noProgress: result.status === "needs_attention",
    regressions: failedChecks.test > 0 &&
        result.verification?.checks.some((check) => check.name.toLowerCase().includes("regression"))
      ? 1
      : 0,
    diagnosis: {
      planInvalidating: result.unresolvedRisks.some((risk) =>
        /\bplan\b.*\b(?:invalid|replace|rewrite)\b/i.test(risk)
      ),
    },
    iteration: { current: result.iteration, budget: result.iteration },
    effects: { safe: true },
    replay: { compatible: true },
    risk: {
      ambiguous: result.unresolvedRisks.some((risk) => /\b(?:ambiguous|unknown)\b/i.test(risk)),
    },
  });
}

function checkFailures(result: CodingWorkflowResult) {
  const failures = { test: 0, typecheck: 0, lint: 0, build: 0 };
  for (const check of result.verification?.checks ?? []) {
    if (check.passed) continue;
    const name = check.name.toLowerCase();
    if (name.includes("type")) failures.typecheck += 1;
    else if (name.includes("lint")) failures.lint += 1;
    else if (name.includes("build")) failures.build += 1;
    else failures.test += 1;
  }
  return failures;
}

import type { ArtifactRef, HostEvidence } from "../evidence/types.ts";
import type { HostEvidenceExecutor, VerificationCheck, VerificationResult } from "./types.ts";

type DefaultIntegrationRunner = HostEvidenceExecutor & {
  defaultIntegrationScripts(): Promise<readonly string[]>;
};

export async function hostIntegrationVerification(
  runner: HostEvidenceExecutor | undefined,
  signal?: AbortSignal,
): Promise<{ readonly verification: VerificationResult; readonly refs: readonly ArtifactRef[] }> {
  if (runner === undefined) return unavailableVerification("trusted host integration runner unavailable");
  const scripts = hasDefaultIntegrationScripts(runner) ? await runner.defaultIntegrationScripts() : [];
  if (scripts.length === 0) return unavailableVerification("no executable host integration scripts configured");
  const evidence: HostEvidence[] = [];
  for (const script of scripts) evidence.push(await runner.runPackageScript(script, signal));
  const checks: readonly VerificationCheck[] = evidence.map((result) => ({
    name: `package:${result.script}`,
    passed: result.passed,
    evidence: `exit=${result.exitCode ?? "signal"};stdout=${result.stdout.digest};stderr=${result.stderr.digest}`,
  }));
  const passed = checks.every((check) => check.passed);
  return {
    verification: {
      passed,
      summary: passed ? "host integration checks passed" : "host integration checks failed",
      checks,
    },
    refs: evidence.flatMap((result) => [result.stdout, result.stderr]),
  };
}

function unavailableVerification(evidence: string): {
  readonly verification: VerificationResult;
  readonly refs: readonly ArtifactRef[];
} {
  return {
    verification: {
      passed: false,
      summary: "trusted host integration checks unavailable",
      checks: [{ name: "host-integration", passed: false, evidence }],
    },
    refs: [],
  };
}

function hasDefaultIntegrationScripts(runner: HostEvidenceExecutor): runner is DefaultIntegrationRunner {
  return "defaultIntegrationScripts" in runner && typeof runner.defaultIntegrationScripts === "function";
}

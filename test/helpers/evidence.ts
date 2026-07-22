import type { HostEvidence } from "../../src/evidence/types.ts";
import type { HostEvidenceExecutor } from "../../src/workflow/types.ts";

export function passingEvidenceRunner(scripts: readonly string[] = ["test"]): HostEvidenceExecutor {
  return conditionalEvidenceRunner(() => true, scripts);
}

export function conditionalEvidenceRunner(
  passed: () => boolean,
  scripts: readonly string[] = ["test"],
): HostEvidenceExecutor {
  return {
    async defaultIntegrationScripts() {
      return scripts;
    },
    async runPackageScript(script: string): Promise<HostEvidence> {
      return evidence(script, passed());
    },
  };
}

export function evidence(script: string, passed: boolean): HostEvidence {
  return {
    script,
    packageManager: "bun",
    exitCode: passed ? 0 : 1,
    signal: null,
    durationMs: 1,
    stdout: { digest: "a".repeat(64), byteCount: 0, truncated: false },
    stderr: { digest: "b".repeat(64), byteCount: 0, truncated: false },
    passed,
  };
}

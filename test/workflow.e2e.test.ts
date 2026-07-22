import { expect, test } from "bun:test";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";
import type { ExecutionRequest, TaskExecutor } from "../src/types.ts";

function json(value: unknown): string {
  return JSON.stringify(value);
}

test("compiles a normal full-stack objective into parallel analysis and evidence-based delivery", async () => {
  let activeSpecialists = 0;
  let peakSpecialists = 0;
  let specialistsStarted = 0;
  let releaseSpecialists: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    releaseSpecialists = resolve;
  });

  const executor: TaskExecutor = {
    async execute(request: ExecutionRequest) {
      if (request.task.id === "discover") {
        return json({
          workItems: [
            { id: "frontend", title: "Frontend", instruction: "Inspect the React client" },
            { id: "backend", title: "Backend", instruction: "Inspect the API and data layer" },
          ],
          acceptanceCriteria: ["The client and API work together", "Relevant checks pass"],
        });
      }
      if (request.task.id.startsWith("specialist_")) {
        activeSpecialists += 1;
        peakSpecialists = Math.max(peakSpecialists, activeSpecialists);
        specialistsStarted += 1;
        if (specialistsStarted === 2) releaseSpecialists();
        await bothStarted;
        activeSpecialists -= 1;
        return json({
          summary: `inspected ${request.task.id}`,
          evidence: [{ kind: "file", location: `src/${request.task.id}.ts`, detail: "relevant implementation" }],
          risks: [],
          discoveredWorkItems: null,
        });
      }
      if (request.task.id === "implement") {
        return json({
          summary: "implemented the full-stack change",
          filesChanged: ["src/client.ts", "src/api.ts"],
          evidence: ["client calls the updated API"],
          unresolvedRisks: [],
        });
      }
      if (request.task.id === "verify") {
        return json({
          passed: true,
          summary: "all checks passed",
          checks: [
            { name: "unit tests", passed: true, evidence: "24 tests passed" },
            { name: "typecheck", passed: true, evidence: "tsc exited 0" },
          ],
        });
      }
      if (request.task.id === "synthesize") return json({ summary: "Shipped and verified." });
      throw new Error(`unexpected task ${request.task.id}`);
    },
  };

  const result = await runCodingWorkflow(
    { objective: "Implement the React settings screen and its API across the full stack" },
    executor,
    {
      threadId: "happy-full-stack",
      retainCheckpoint: true,
      evidenceRunner: {
        async defaultIntegrationScripts() { return ["test"]; },
        async runPackageScript(script) {
          const artifact = { digest: "a".repeat(64), byteCount: 0, truncated: false };
          return {
            script,
            packageManager: "bun",
            exitCode: 0,
            signal: null,
            durationMs: 1,
            stdout: artifact,
            stderr: artifact,
            passed: true,
          };
        },
      },
    },
  );

  expect(peakSpecialists).toBe(2);
  expect(result.pattern).toBe("delivery");
  expect(result.status).toBe("completed");
  expect(result.findings.map((finding) => finding.workItemId).sort()).toEqual(["backend", "frontend"]);
  expect(result.verification?.passed).toBe(true);
  expect(result.verification?.checks).toEqual([
    expect.objectContaining({ name: "package:test", passed: true }),
  ]);
  expect(result.summary).toBe("Shipped and verified.");
  expect(result.trace.map((event) => event.node)).toEqual([
    "classify",
    "discover",
    "specialist",
    "specialist",
    "implement",
    "verify",
    "synthesize",
  ]);
});

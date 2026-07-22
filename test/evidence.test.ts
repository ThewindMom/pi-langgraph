import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostEvidenceRunner } from "../src/evidence/runner.ts";
import type { ArtifactRef } from "../src/evidence/types.ts";

test("host exit status overrides a worker claim and outputs are bounded artifact refs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-langgraph-evidence-"));
  const artifacts: string[] = [];
  const artifactStore = {
    async put(content: string | Uint8Array): Promise<ArtifactRef> {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      artifacts.push(new TextDecoder().decode(bytes));
      return { digest: "sha256:test", byteCount: bytes.byteLength, truncated: false };
    },
  };
  try {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ packageManager: "bun@1.3.14", scripts: {
      fail: "node -e 'process.exit(7)'",
      secrets: "node -e \"console.log(JSON.stringify({apiKey:'sk-proj-secret-value'})); console.error('Authorization: Bearer ghp_secret-value')\"",
    } }));
    const runner = new HostEvidenceRunner({ cwd, artifactStore });
    const evidence = await runner.runPackageScript("fail");

    expect(evidence.exitCode).toBe(7);
    expect(evidence.passed).toBe(false);
    expect(evidence.stdout).toMatchObject({ digest: "sha256:test", byteCount: expect.any(Number) });
    expect(evidence.stderr).toMatchObject({ digest: "sha256:test", byteCount: expect.any(Number) });
    expect(artifacts.every((value) => value.length <= 64 * 1024)).toBe(true);
    artifacts.length = 0;
    await runner.runPackageScript("secrets");
    expect(artifacts.join("\\n")).not.toContain("sk-proj-secret-value");
    expect(artifacts.join("\\n")).not.toContain("ghp_secret-value");
    expect(artifacts.join("\\n")).toContain("[REDACTED]");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

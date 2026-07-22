import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redactOutput } from "../src/evidence/redaction.ts";
import { createRepositorySnapshot } from "../src/repository/snapshot.ts";

test("redacts structured credentials and private key blocks", () => {
  const input = '{"apiKey":"secret-json","AWS_SECRET_ACCESS_KEY": aws-secret} password: "yaml-secret" Authorization: Basic dXNlcjpwYXNz -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY----- sk-proj-abcdefghijklmnop';
  const output = redactOutput(input);
  expect(output).not.toContain("secret-json");
  expect(output).not.toContain("aws-secret");
  expect(output).not.toContain("yaml-secret");
  expect(output).not.toContain("dXNlcjpwYXNz");
  expect(output).not.toContain("-----BEGIN PRIVATE KEY-----");
  expect(output).not.toContain("sk-proj-abcdefghijklmnop");
});

test("rejects symlinked untracked entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-snapshot-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-langgraph-outside-"));
  try {
    await mkdir(join(root, ".git"));
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    expect(init.exitCode).toBe(0);
    await writeFile(join(root, "package.json"), "{}");
    Bun.spawnSync(["git", "add", "package.json"] , { cwd: root });
    Bun.spawnSync(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init"], { cwd: root });
    await writeFile(join(outside, "secret.txt"), "outside");
    await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
    await expect(createRepositorySnapshot(root)).rejects.toThrow("symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

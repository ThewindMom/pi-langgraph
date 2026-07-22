import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryMemory } from "../src/memory/repository-memory.ts";
import { createRepositorySnapshot } from "../src/repository/snapshot.ts";

const provenance = {
  sourceCheckpointId: "checkpoint-1",
  artifactRefs: [],
  observedAt: "2026-07-22T00:00:00.000Z",
  schemaVersion: 1,
  confidence: 0.9,
} as const;

test("returns provenance memory only for the repository snapshot that observed it", async () => {
  // Given: a clean Git repository and a persisted architecture fact.
  const fixture = await createRepositoryFixture("memory-tracked");

  try {
    const memory = await RepositoryMemory.open(join(fixture.root, "memory"));
    const originalSnapshot = await createRepositorySnapshot(fixture.repository);
    const fact = { value: "src/domain.ts owns domain policy", provenance } as const;
    await memory.put(originalSnapshot, "architecture:domain-owner", fact);

    // When: a tracked source file changes.
    await writeFile(join(fixture.repository, "src.ts"), "export const version = 2;\n");
    const changedSnapshot = await createRepositorySnapshot(fixture.repository);

    // Then: the prior fact remains restart-readable only under its original provenance snapshot.
    const reopened = await RepositoryMemory.open(join(fixture.root, "memory"));
    expect(await reopened.get(originalSnapshot, "architecture:domain-owner")).toEqual(fact);
    expect(changedSnapshot).not.toBe(originalSnapshot);
    expect(await reopened.get(changedSnapshot, "architecture:domain-owner")).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalidates memory when relevant untracked content changes", async () => {
  // Given: memory recorded before an untracked source file exists.
  const fixture = await createRepositoryFixture("memory-untracked");

  try {
    const memory = await RepositoryMemory.open(join(fixture.root, "memory"));
    const before = await createRepositorySnapshot(fixture.repository);
    await memory.put(before, "tests:command", { value: "bun test", provenance });

    // When: relevant untracked repository content is added.
    await writeFile(join(fixture.repository, "new-test.ts"), "export const uncovered = true;\n");
    const after = await createRepositorySnapshot(fixture.repository);

    // Then: the new snapshot cannot consume the old advisory fact.
    expect(after).not.toBe(before);
    expect(await memory.get(after, "tests:command")).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalidates memory when tracked toolchain configuration changes", async () => {
  // Given: memory tied to the committed package manifest.
  const fixture = await createRepositoryFixture("memory-config");

  try {
    const memory = await RepositoryMemory.open(join(fixture.root, "memory"));
    const before = await createRepositorySnapshot(fixture.repository);
    await memory.put(before, "toolchain:test", { value: "bun test", provenance });

    // When: the package test command changes without a commit.
    await writeFile(join(fixture.repository, "package.json"), '{"scripts":{"test":"bun test --coverage"}}\n');
    const after = await createRepositorySnapshot(fixture.repository);

    // Then: configuration participates in snapshot identity and invalidates the fact.
    expect(after).not.toBe(before);
    expect(await memory.get(after, "toolchain:test")).toBeUndefined();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createRepositoryFixture(name: string): Promise<{ readonly root: string; readonly repository: string }> {
  const root = await mkdtemp(join(tmpdir(), `pi-langgraph-${name}-`));
  const repository = join(root, "repository");
  await mkdir(repository);
  await Bun.write(join(repository, "src.ts"), "export const version = 1;\n");
  await Bun.write(join(repository, "package.json"), '{"scripts":{"test":"bun test"}}\n');
  runGit(repository, ["init"]);
  runGit(repository, ["config", "user.name", "Pi LangGraph Test"]);
  runGit(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  runGit(repository, ["add", "."]);
  runGit(repository, ["commit", "-m", "fixture"]);
  return { root, repository };
}

function runGit(cwd: string, args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

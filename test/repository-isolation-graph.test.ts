import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryServices } from "../src/runtime/repository-services.ts";
import { SourceTreeTransaction } from "../src/repository/source-tree-transaction.ts";
import type { TaskExecutor } from "../src/types.ts";
import { runCodingWorkflow } from "../src/workflow/runtime.ts";

test("does not retry a graph node whose read-only worker violates repository isolation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-retry-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  let calls = 0;
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      calls += 1;
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "source.ts"), "export const value = 2;\n");
      throw new Error("delegate failed after mutation");
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(runCodingWorkflow(
      { objective: "inspect source" },
      services.executor,
      { threadId: "read-only-isolation-no-retry", retainCheckpoint: true },
    )).rejects.toThrow("read-only Pi worker mutated");
    expect(calls).toBe(1);
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish an authorized mutation when the worker fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-failure-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "source.ts"), "export const value = 2;\n");
      throw new Error("worker failed validation");
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "change source",
      task: { id: "implement_source", prompt: "change source", allowedFiles: ["source.ts"] },
      dependencyResults: [],
    })).rejects.toThrow("worker failed validation");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not publish a mutation whose successful output omits an actual file change", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-report-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "source.ts"), "export const value = 2;\n");
      return JSON.stringify({ summary: "changed", filesChanged: [], evidence: [], unresolvedRisks: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "change source",
      task: { id: "implement_source", prompt: "change source", allowedFiles: ["source.ts"] },
      dependencyResults: [],
    })).rejects.toThrow("change report did not match");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an escaping committed symlink before a read-only worker can follow it", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-symlink-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  await symlink(join(repository, "source.ts"), join(repository, "escape.ts"));
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  let calls = 0;
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      calls += 1;
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "escape.ts"), "source overwritten\n");
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "inspect",
      task: { id: "discover", prompt: "inspect" },
      dependencyResults: [],
    })).rejects.toThrow("symlink escapes isolated workspace");
    expect(calls).toBe(0);
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an unattributable source write through a newly created absolute symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-created-symlink-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const dirtyBaseline = "export const value = 'user draft';\n";
  await writeFile(join(repository, "source.ts"), dirtyBaseline);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await symlink(join(repository, "source.ts"), join(options.workingDirectory, "escape.ts"));
      await writeFile(join(options.workingDirectory, "escape.ts"), "source overwritten\n");
      return JSON.stringify({
        summary: "changed source",
        filesChanged: ["source.ts"],
        evidence: [],
        unresolvedRisks: [],
      });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "change source",
      task: { id: "implement_source", prompt: "change source", allowedFiles: ["source.ts"] },
      dependencyResults: [],
    })).rejects.toThrow("source changed while Pi worker ran");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("source overwritten\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves an unattributable source write when its executor also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-error-symlink-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const dirtyBaseline = "export const value = 'unfinished user work';\n";
  await writeFile(join(repository, "source.ts"), dirtyBaseline);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await symlink(join(repository, "source.ts"), join(options.workingDirectory, "escape.ts"));
      await writeFile(join(options.workingDirectory, "escape.ts"), "source overwritten before failure\n");
      throw new Error("worker failed after source escape");
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "change source",
      task: { id: "implement_source", prompt: "change source", allowedFiles: ["source.ts"] },
      dependencyResults: [],
    })).rejects.toThrow("source changed while Pi worker ran");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("source overwritten before failure\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a legitimate concurrent source edit while rejecting the stale worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-concurrent-edit-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const workerReady = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const delegate: TaskExecutor = {
    async execute() {
      workerReady.resolve();
      await releaseWorker.promise;
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    const execution = services.executor.execute({
      objective: "inspect source",
      task: { id: "discover", prompt: "inspect source" },
      dependencyResults: [],
    });
    await workerReady.promise;
    const concurrentEdit = "export const value = 'edited by user';\n";
    await writeFile(join(repository, "source.ts"), concurrentEdit);
    releaseWorker.resolve();
    await expect(execution).rejects.toThrow("source changed while Pi worker ran");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe(concurrentEdit);
  } finally {
    releaseWorker.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves a same-target concurrent edit when a worker only creates an absolute symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-same-target-edit-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const linkCreated = Promise.withResolvers<void>();
  const releaseWorker = Promise.withResolvers<void>();
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await symlink(join(repository, "source.ts"), join(options.workingDirectory, "escape.ts"));
      linkCreated.resolve();
      await releaseWorker.promise;
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    const execution = services.executor.execute({
      objective: "inspect source",
      task: { id: "discover", prompt: "inspect source" },
      dependencyResults: [],
    });
    await linkCreated.promise;
    const concurrentEdit = "export const value = 'same target user edit';\n";
    await writeFile(join(repository, "source.ts"), concurrentEdit);
    releaseWorker.resolve();
    await expect(execution).rejects.toThrow("source changed while Pi worker ran");
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe(concurrentEdit);
  } finally {
    releaseWorker.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test("restores the full baseline when publication fails after its first source write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-publication-rollback-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "b.ts"), "export const b = 1;\n");
  const transaction = await SourceTreeTransaction.open(repository);
  try {
    await expect(transaction.publish(
      ["new/a.ts", "b.ts"],
      async (candidateRoot) => {
        await mkdir(join(candidateRoot, "new"));
        await writeFile(join(candidateRoot, "new", "a.ts"), "export const a = 2;\n");
        await writeFile(join(candidateRoot, "b.ts"), "export const b = 2;\n");
      },
      async (candidateRoot) => {
        await mkdir(join(repository, "new"));
        await copyFile(join(candidateRoot, "new", "a.ts"), join(repository, "new", "a.ts"));
        throw new Error("publication failed after new/a.ts");
      },
    )).rejects.toThrow("publication failed after new/a.ts");
    await expect(lstat(join(repository, "new"))).rejects.toThrow();
    expect(await readFile(join(repository, "b.ts"), "utf8")).toBe("export const b = 1;\n");
  } finally {
    await transaction.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("removes an empty parent created before publication copies its first file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-publication-empty-parent-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  const transaction = await SourceTreeTransaction.open(repository);
  try {
    await expect(transaction.publish(
      ["new/a.ts"],
      async (candidateRoot) => {
        await mkdir(join(candidateRoot, "new"));
        await writeFile(join(candidateRoot, "new", "a.ts"), "export const a = 1;\n");
      },
      async () => {
        await mkdir(join(repository, "new"));
        throw new Error("publication failed before copying a.ts");
      },
    )).rejects.toThrow("publication failed before copying a.ts");
    await expect(lstat(join(repository, "new"))).rejects.toThrow();
  } finally {
    await transaction.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves concurrent contents in a parent created by a failed publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-publication-concurrent-parent-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "b.ts"), "export const b = 1;\n");
  const transaction = await SourceTreeTransaction.open(repository);
  try {
    await expect(transaction.publish(
      ["new/a.ts", "b.ts"],
      async (candidateRoot) => {
        await mkdir(join(candidateRoot, "new"));
        await writeFile(join(candidateRoot, "new", "a.ts"), "export const a = 2;\n");
        await writeFile(join(candidateRoot, "b.ts"), "export const b = 2;\n");
      },
      async (candidateRoot) => {
        await mkdir(join(repository, "new"));
        await copyFile(join(candidateRoot, "new", "a.ts"), join(repository, "new", "a.ts"));
        await writeFile(join(repository, "new", "user.txt"), "concurrent user content\n");
        throw new Error("publication failed after concurrent parent edit");
      },
    )).rejects.toThrow("publication failed after concurrent parent edit");
    await expect(readFile(join(repository, "new", "a.ts"))).rejects.toThrow();
    expect(await readFile(join(repository, "new", "user.txt"), "utf8")).toBe("concurrent user content\n");
    expect(await readFile(join(repository, "b.ts"), "utf8")).toBe("export const b = 1;\n");
  } finally {
    await transaction.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes independent source publications and rejects the stale transaction", async () => {
  // Given: two transactions captured from the same exact source baseline.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-publication-lock-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  const first = await SourceTreeTransaction.open(repository);
  const second = await SourceTreeTransaction.open(repository);
  const firstPublishing = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  try {
    const firstAction = first.publish(
      ["source.ts"],
      (candidateRoot) => writeFile(join(candidateRoot, "source.ts"), "export const value = 2;\n"),
      async (candidateRoot) => {
        firstPublishing.resolve();
        await releaseFirst.promise;
        await copyFile(join(candidateRoot, "source.ts"), join(repository, "source.ts"));
      },
    );
    await firstPublishing.promise;

    // When: the second transaction attempts to publish while the first owns the source-root lock.
    const secondAction = second.publish(
      ["source.ts"],
      (candidateRoot) => writeFile(join(candidateRoot, "source.ts"), "export const value = 3;\n"),
      (candidateRoot) => copyFile(join(candidateRoot, "source.ts"), join(repository, "source.ts")),
    );
    releaseFirst.resolve();
    const results = await Promise.allSettled([firstAction, secondAction]);

    // Then: only the lock owner publishes and the stale baseline is rejected after lock acquisition.
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status === "rejected" ? results[1].reason : undefined)
      .toMatchObject({ operation: "snapshot" });
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 2;\n");
  } finally {
    releaseFirst.resolve();
    await Promise.all([first.close(), second.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("validates every authorized entry before publishing any mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolation-fifo-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "good.ts"), "export const good = true;\n");
      const fifo = spawnSync("mkfifo", [join(options.workingDirectory, "pipe")], { encoding: "utf8" });
      if (fifo.status !== 0) throw new Error(fifo.stderr);
      return JSON.stringify({
        summary: "created entries",
        filesChanged: ["good.ts", "pipe"],
        evidence: [],
        unresolvedRisks: [],
      });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "create entries",
      task: { id: "implement_entries", prompt: "create", allowedFiles: ["good.ts", "pipe"] },
      dependencyResults: [],
    })).rejects.toThrow("refusing to publish special file: pipe");
    await expect(readFile(join(repository, "good.ts"))).rejects.toThrow();
    await expect(readFile(join(repository, "pipe"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

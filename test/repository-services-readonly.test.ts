import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryServices } from "../src/runtime/repository-services.ts";
import type { ExecutionRequest, TaskExecutor } from "../src/types.ts";

test("rejects and never caches a read-only Pi worker that mutates repository state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-readonly-fence-"));
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
      await writeFile(join(options.workingDirectory, "source.ts"), `export const value = ${calls + 1};\n`);
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "native", inheritedModel: null, activeTools: ["task"], protocol: "test" },
    });
    const request: ExecutionRequest = {
      objective: "inspect only",
      task: { id: "discover", prompt: "inspect" },
      dependencyResults: [],
    };

    await expect(services.executor.execute(request)).rejects.toThrow("read-only Pi worker mutated");
    await expect(services.executor.execute(request)).rejects.toThrow("read-only Pi worker mutated");
    expect(calls).toBe(2);
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a mutation worker that edits a sibling change outside its exact plan scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-mutation-scope-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await mkdir(join(repository, "src"));
  await writeFile(join(repository, "src", "catalog.ts"), "export const catalog = [];\n");
  await writeFile(join(repository, "src", "format.ts"), "export const format = (value: string) => value;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "src", "catalog.ts"), "export const catalog = ['alpha'];\n");
      await writeFile(join(options.workingDirectory, "src", "format.ts"), "export const format = (value: string) => value.toUpperCase();\n");
      return JSON.stringify({ summary: "changed both", filesChanged: ["src/catalog.ts", "src/format.ts"], evidence: [], unresolvedRisks: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "change catalog only",
      task: { id: "implement_catalog", prompt: "change catalog", allowedFiles: ["src/catalog.ts"] },
      dependencyResults: [],
    })).rejects.toThrow("outside its planned scope: src/format.ts");
    expect(await readFile(join(repository, "src", "catalog.ts"), "utf8")).toBe("export const catalog = [];\n");
    expect(await readFile(join(repository, "src", "format.ts"), "utf8")).toBe(
      "export const format = (value: string) => value;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects ignored and Git metadata writes without changing source bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolated-metadata-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, ".gitignore"), "ignored/\n");
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const headBefore = await readFile(join(repository, ".git", "HEAD"));
  const indexBefore = await readFile(join(repository, ".git", "index"));
  const branch = gitOutput(repository, ["symbolic-ref", "--short", "HEAD"]);
  const refPath = join(repository, ".git", "refs", "heads", branch);
  const refBefore = await readFile(refPath);
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await mkdir(join(options.workingDirectory, "ignored"));
      await writeFile(join(options.workingDirectory, "ignored", "worker.txt"), "not published\n");
      await writeFile(join(options.workingDirectory, ".git", "HEAD"), "ref: refs/heads/other\n");
      await writeFile(join(options.workingDirectory, ".git", "index"), "worker index\n");
      await writeFile(join(options.workingDirectory, ".git", "refs", "heads", branch), "0".repeat(40));
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await expect(services.executor.execute({
      objective: "inspect only",
      task: { id: "discover", prompt: "inspect" },
      dependencyResults: [],
    })).rejects.toThrow("read-only Pi worker mutated");
    expect(await readFile(join(repository, ".git", "HEAD"))).toEqual(headBefore);
    expect(await readFile(join(repository, ".git", "index"))).toEqual(indexBefore);
    expect(await readFile(refPath)).toEqual(refBefore);
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
    await expect(readFile(join(repository, "ignored", "worker.txt"))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows a semantic no-op Git index refresh inside a read-only worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-index-refresh-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  const indexBefore = await readFile(join(repository, ".git", "index"));
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      const later = new Date(Date.now() + 10_000);
      await utimes(join(options.workingDirectory, "source.ts"), later, later);
      git(options.workingDirectory, ["status", "--short"]);
      return JSON.stringify({ workItems: [], acceptanceCriteria: [] });
    },
  };
  try {
    const services = await RepositoryServices.open(join(root, "data"), repository, {
      executor: delegate,
      policy: { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: "test" },
    });
    await services.executor.execute({
      objective: "inspect only",
      task: { id: "discover", prompt: "inspect" },
      dependencyResults: [],
    });
    expect(await readFile(join(repository, ".git", "index"))).toEqual(indexBefore);
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 1;\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publishes only a successful mutation's exact authorized file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-isolated-publish-"));
  const repository = join(root, "repository");
  await mkdir(repository);
  await writeFile(join(repository, "source.ts"), "export const value = 1;\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
  await writeFile(join(repository, "user-notes.txt"), "uncommitted user draft\n");
  const delegate: TaskExecutor = {
    async execute(_request, _signal, options) {
      if (options?.workingDirectory === undefined) throw new Error("missing isolated working directory");
      await writeFile(join(options.workingDirectory, "source.ts"), "export const value = 2;\n");
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
    await services.executor.execute({
      objective: "change source",
      task: { id: "implement_source", prompt: "change source", allowedFiles: ["source.ts"] },
      dependencyResults: [],
    });
    expect(await readFile(join(repository, "source.ts"), "utf8")).toBe("export const value = 2;\n");
    expect(await readFile(join(repository, "user-notes.txt"), "utf8")).toBe("uncommitted user draft\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function gitOutput(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function sourceFiles(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) paths.push(path);
  }
  return paths;
}

test("production runtime does not require Bun globals inside Senpi's Node host", async () => {
  const projectRoot = join(import.meta.dir, "..");
  const sourceRoot = join(projectRoot, "src");
  const offenders: string[] = [];
  for (const path of await sourceFiles(sourceRoot)) {
    if (/\bBun\b/.test(await readFile(path, "utf8"))) offenders.push(path);
  }
  expect(offenders).toEqual([]);

  const buildRoot = await mkdtemp(join(tmpdir(), "pi-langgraph-node-host-"));
  try {
    const entry = join(buildRoot, "index.mjs");
    const build = spawnSync("bun", [
      "build", "./src/index.ts", "--target", "node", "--outfile", entry,
      "--external", "@earendil-works/pi-coding-agent",
    ], { cwd: projectRoot, encoding: "utf8" });
    expect(build.status).toBe(0);
    const result = spawnSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(entry)})`], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
});

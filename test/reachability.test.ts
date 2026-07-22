import { expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/persistence/artifact-store.ts";
import { RetentionIndex } from "../src/persistence/reachability.ts";

test("retains lineage across restart and releases the final owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-retention-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-langgraph-retention-artifacts-"));
  try {
    const store = await ArtifactStore.open(artifacts);
    const ref = await store.put("lineage");
    const index = await RetentionIndex.open(root);
    await index.pin({ kind: "checkpoint", id: "cp-1" }, [ref]);
    const reopened = await RetentionIndex.open(root);
    expect(reopened.reachable().has(ref.digest)).toBe(true);
    expect((await reopened.compact(store)).removed).toEqual([]);
    await reopened.release({ kind: "checkpoint", id: "cp-1" });
    expect((await reopened.compact(store)).removed).toEqual([ref.digest]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("writes a bounded private manifest and rejects invalid owner paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-retention-mode-"));
  try {
    const index = await RetentionIndex.open(root);
    await expect(index.pin({ kind: "thread", id: "../escape" }, [])).rejects.toThrow(/invalid retention owner/);
    const info = await lstat(join(root, "retention.json")).catch(() => undefined);
    expect(info).toBeUndefined();
    await index.pin({ kind: "thread", id: "safe" }, []);
    const manifest = await readFile(join(root, "retention.json"));
    expect(manifest.byteLength).toBeLessThan(1024 * 1024);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves owners written by independent repository processes during compaction", async () => {
  // Given: two repository-service instances opened before either publishes an owner.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-retention-concurrent-"));
  const artifacts = await mkdtemp(join(tmpdir(), "pi-langgraph-retention-concurrent-artifacts-"));
  try {
    const store = await ArtifactStore.open(artifacts);
    const paused = await store.put("paused checkpoint evidence");
    const forked = await store.put("fork evidence");
    const first = await RetentionIndex.open(root);
    const second = await RetentionIndex.open(root);

    // When: independent instances register a paused checkpoint and fork, then a new process compacts.
    await first.pin({ kind: "checkpoint", id: "paused-checkpoint" }, [paused]);
    await second.pin({ kind: "fork", id: "fork-thread" }, [forked]);
    const process = Bun.spawn([
      "bun", "-e",
      `import { ArtifactStore } from ${JSON.stringify(new URL("../src/persistence/artifact-store.ts", import.meta.url).href)}; import { RetentionIndex } from ${JSON.stringify(new URL("../src/persistence/reachability.ts", import.meta.url).href)}; const index = await RetentionIndex.open(${JSON.stringify(root)}); const store = await ArtifactStore.open(${JSON.stringify(artifacts)}); await index.compact(store);`,
    ], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await process.exited;

    // Then: both durable owners survive the stale-instance write and second-process GC.
    expect(exitCode).toBe(0);
    const reopened = await RetentionIndex.open(root);
    expect([...reopened.reachable()].sort()).toEqual([forked.digest, paused.digest].sort());
    expect(new TextDecoder().decode(await store.get(paused))).toBe("paused checkpoint evidence");
    expect(new TextDecoder().decode(await store.get(forked))).toBe("fork evidence");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

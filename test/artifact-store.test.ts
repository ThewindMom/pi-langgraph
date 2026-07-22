import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/persistence/artifact-store.ts";

test("deduplicates content by SHA-256 and resolves it after restart", async () => {
  // Given: an empty durable artifact directory and one payload.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-artifacts-"));
  const payload = "bounded command output\n";

  try {
    const store = await ArtifactStore.open(root);

    // When: identical bytes are stored twice and the store is reopened.
    const first = await store.put(payload);
    const duplicate = await store.put(new TextEncoder().encode(payload));
    const reopened = await ArtifactStore.open(root);

    // Then: both writes share the canonical digest and restart resolution returns exact bytes.
    expect(duplicate).toEqual(first);
    expect(first.digest).toBe(createHash("sha256").update(payload).digest("hex"));
    expect(new TextDecoder().decode(await reopened.get(first))).toBe(payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compacts only artifacts unreachable from retained owners", async () => {
  // Given: two artifacts where a checkpoint owner pins only one.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-artifact-gc-"));

  try {
    const store = await ArtifactStore.open(root);
    const retained = await store.put("retained evidence");
    const orphan = await store.put("unreachable scratch output");
    await store.pin("checkpoint:thread-a:checkpoint-1", [retained]);

    // When: reachability compaction runs.
    const result = await store.compact();

    // Then: the pinned bytes remain resolvable and only the orphan is removed.
    expect(result.removed).toEqual([orphan.digest]);
    expect(new TextDecoder().decode(await store.get(retained))).toBe("retained evidence");
    await expect(store.get(orphan)).rejects.toThrow(/not found|missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes content only after its final reachability owner is unpinned", async () => {
  // Given: one blob reachable from a retained checkpoint and a fork manifest.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-artifact-pins-"));

  try {
    const store = await ArtifactStore.open(root);
    const shared = await store.put("shared evidence");
    await store.pin("checkpoint:source", [shared]);
    await store.pin("fork:child", [shared]);

    // When: owners are released one at a time with compaction between them.
    await store.unpin("checkpoint:source");
    const stillReachable = await store.compact();
    await store.unpin("fork:child");
    const nowUnreachable = await store.compact();

    // Then: the first collection preserves the blob and the second removes it exactly once.
    expect(stillReachable.removed).toEqual([]);
    expect(nowUnreachable.removed).toEqual([shared.digest]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

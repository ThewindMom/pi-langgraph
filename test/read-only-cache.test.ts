import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadOnlyCache } from "../src/cache/read-only-cache.ts";

const artifact = {
  digest: "a".repeat(64),
  byteCount: 7,
} as const;

test("reuses an artifact only for an identical snapshot, input, operation, and policy", async () => {
  // Given: a cached discovery artifact for one fully normalized read-only key.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-cache-hit-"));
  const key = {
    snapshotId: "snapshot-a",
    operation: "discovery",
    inputHash: "objective-a",
    policyHash: "agent-config-a:protocol-v1",
  } as const;

  try {
    const cache = await ReadOnlyCache.open(root);
    await cache.set(key, artifact);

    // When: the cache is reopened with the identical key.
    const reopened = await ReadOnlyCache.open(root);
    const hit = await reopened.get(key);

    // Then: restart reuse returns the content-addressed reference.
    expect(hit).toEqual(artifact);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("misses independently for repository, input, configuration, and protocol changes", async () => {
  // Given: one cached read-only specialist result.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-cache-invalidation-"));
  const original = {
    snapshotId: "snapshot-before-tracked-untracked-and-config",
    operation: "specialist",
    inputHash: "normalized-input-v1",
    policyHash: "agent-config-v1:protocol-v1",
  } as const;

  try {
    const cache = await ReadOnlyCache.open(root);
    await cache.set(original, artifact);

    // When: each identity dimension is changed in isolation.
    const snapshotMiss = await cache.get({ ...original, snapshotId: "snapshot-after-untracked-edit" });
    const inputMiss = await cache.get({ ...original, inputHash: "normalized-input-v2" });
    const configMiss = await cache.get({ ...original, policyHash: "agent-config-v2:protocol-v1" });
    const protocolMiss = await cache.get({ ...original, policyHash: "agent-config-v1:protocol-v2" });

    // Then: none of the stale entries are reused.
    expect([snapshotMiss, inputMiss, configMiss, protocolMiss]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects mutation and final-verification operations instead of caching them", async () => {
  // Given: cache keys for operations that may mutate or decide completion.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-cache-mutation-"));
  const base = {
    snapshotId: "snapshot-a",
    inputHash: "change-a",
    policyHash: "policy-a",
  } as const;

  try {
    const cache = await ReadOnlyCache.open(root);

    // When: callers attempt to persist non-read-only outcomes.
    const mutation = cache.set({ ...base, operation: "implement" }, artifact);
    const repair = cache.set({ ...base, operation: "repair" }, artifact);
    const verification = cache.set({ ...base, operation: "final-verification" }, artifact);

    // Then: the host cache policy rejects every write.
    await expect(mutation).rejects.toThrow(/read-only/i);
    await expect(repair).rejects.toThrow(/read-only/i);
    await expect(verification).rejects.toThrow(/read-only/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "@langchain/langgraph-checkpoint";
import { assertCheckpointFileSize } from "../src/persistence/checkpoint-file-io.ts";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { MAX_CHECKPOINT_FILE_BYTES } from "../src/persistence/file-checkpoint-format.ts";

const OVERSIZED_VALUE = "x".repeat(7 * 1024 * 1024);

test("checkpoint capacity counts final UTF-8 bytes including the trailing newline", () => {
  expect(() => assertCheckpointFileSize(`${"a".repeat(MAX_CHECKPOINT_FILE_BYTES - 1)}\n`)).not.toThrow();
  expect(() => assertCheckpointFileSize(`${"a".repeat(MAX_CHECKPOINT_FILE_BYTES)}\n`)).toThrow(
    `checkpoint thread exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes`,
  );
  expect(() => assertCheckpointFileSize("\u00e9".repeat(MAX_CHECKPOINT_FILE_BYTES / 2 + 1))).toThrow(
    "received 8388610",
  );
});

test("an oversized checkpoint put preserves the last readable durable state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-capacity-put-"));
  const directory = join(root, "checkpoints");
  const threadId = "capacity-put";

  try {
    const saver = await FileCheckpointSaver.open(directory);
    const accepted = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("checkpoint-1", { marker: "accepted" }),
      metadata(),
      {},
    );
    const path = join(directory, checkpointFileName(threadId));
    const before = await readFile(path);

    await expect(
      saver.put(accepted, checkpoint("checkpoint-2", { payload: OVERSIZED_VALUE }), metadata(), {}),
    ).rejects.toThrow("checkpoint thread exceeds");

    expect((await saver.getTuple({ configurable: { thread_id: threadId } }))?.checkpoint.id).toBe("checkpoint-1");
    expect(await readFile(path)).toEqual(before);
    const reopened = await FileCheckpointSaver.open(directory);
    expect((await reopened.getTuple({ configurable: { thread_id: threadId } }))?.checkpoint.id).toBe("checkpoint-1");
    expect(reopened.quarantinedFiles).toEqual([]);
    expect((await readdir(directory)).some((file) => file.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized pending write preserves prior writes in memory and on disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-capacity-writes-"));
  const directory = join(root, "checkpoints");
  const threadId = "capacity-writes";

  try {
    const saver = await FileCheckpointSaver.open(directory);
    const config = await saver.put(
      { configurable: { thread_id: threadId } },
      checkpoint("checkpoint-1", {}),
      metadata(),
      {},
    );
    await saver.putWrites(config, [["small", "accepted"]], "task-1");
    const path = join(directory, checkpointFileName(threadId));
    const before = await readFile(path);

    await expect(saver.putWrites(config, [["large", OVERSIZED_VALUE]], "task-2")).rejects.toThrow(
      "checkpoint thread exceeds",
    );

    expect((await saver.getTuple(config))?.pendingWrites).toEqual([["task-1", "small", "accepted"]]);
    expect(await readFile(path)).toEqual(before);
    const reopened = await FileCheckpointSaver.open(directory);
    expect((await reopened.getTuple(config))?.pendingWrites).toEqual([["task-1", "small", "accepted"]]);
    expect(reopened.quarantinedFiles).toEqual([]);
    expect((await readdir(directory)).some((file) => file.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function checkpoint(id: string, channelValues: Readonly<Record<string, unknown>>): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { ...channelValues },
    channel_versions: {},
    versions_seen: {},
  };
}

function metadata() {
  return { source: "input" as const, step: -1, parents: {} };
}

function checkpointFileName(threadId: string): string {
  return `${createHash("sha256").update(threadId).digest("hex")}.checkpoint.json`;
}

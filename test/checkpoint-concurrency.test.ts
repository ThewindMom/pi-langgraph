import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { FileCheckpointSaver } from "../src/persistence/file-checkpoint-saver.ts";
import { withCheckpointFileLock } from "../src/persistence/file-lock.ts";

const operation = { kind: "implement", iteration: 0 } as const;

test("serializes stale saver instances so only one can claim a thread mutation", async () => {
  // Given: two saver instances opened before either writes the same thread.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-saver-instances-"));

  try {
    const first = await FileCheckpointSaver.open(root);
    const second = await FileCheckpointSaver.open(root);

    // When: both instances contend for the identical mutation claim.
    const claims = await Promise.all([
      first.claimMutation("contended-thread", operation),
      second.claimMutation("contended-thread", operation),
    ]);

    // Then: exactly one executes and the other observes the durable in-flight claim.
    expect(claims.map((claim) => claim.status).sort()).toEqual(["execute", "indeterminate"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes mutation claims across independent Bun processes", async () => {
  // Given: two child processes that each open the same checkpoint directory before claiming.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-saver-processes-"));
  const moduleUrl = new URL("../src/persistence/file-checkpoint-saver.ts", import.meta.url).href;
  const script = `
    const { FileCheckpointSaver } = await import(${JSON.stringify(moduleUrl)});
    const saver = await FileCheckpointSaver.open(process.argv[1]);
    process.stdout.write("ready\\n");
    await Bun.stdin.text();
    const claim = await saver.claimMutation(process.argv[2], { kind: "implement", iteration: 0 });
    process.stdout.write(JSON.stringify(claim) + "\\n");
  `;

  try {
    const first = spawnContender(script, root, "process-thread");
    const second = spawnContender(script, root, "process-thread");
    const firstReady = await first.reader.read();
    const secondReady = await second.reader.read();
    expect(new TextDecoder().decode(firstReady.value)).toContain("ready");
    expect(new TextDecoder().decode(secondReady.value)).toContain("ready");

    // When: both already-open processes are released to claim concurrently.
    first.process.stdin.write("go\n");
    second.process.stdin.write("go\n");
    first.process.stdin.end();
    second.process.stdin.end();
    const firstResult = await readRemaining(first.reader);
    const secondResult = await readRemaining(second.reader);
    const exitCodes = await Promise.all([first.process.exited, second.process.exited]);

    // Then: both processes exit cleanly, with one execute and one indeterminate claim.
    expect(exitCodes).toEqual([0, 0]);
    expect([claimStatus(firstResult), claimStatus(secondResult)].sort()).toEqual(["execute", "indeterminate"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers a dead-owner lock without changing a neighboring thread", async () => {
  // Given: a completed neighboring claim and a stale same-host lock for another thread.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-stale-lock-"));
  const staleThread = "stale-thread";
  const staleLock = join(root, `${createHash("sha256").update(staleThread).digest("hex")}.lock`);

  try {
    const saver = await FileCheckpointSaver.open(root);
    await saver.claimMutation("neighbor-thread", operation);
    await saver.completeMutation("neighbor-thread", operation, "neighbor output");
    await writeFile(
      staleLock,
      `${JSON.stringify({ version: 1, threadId: staleThread, pid: 2_147_483_647, startedAt: 0, nonce: "dead-owner", hostname: hostname() })}\n`,
      { mode: 0o600 },
    );

    // When: a new instance encounters the stale lock and claims its thread.
    const reopened = await FileCheckpointSaver.open(root);
    const recovered = await reopened.claimMutation(staleThread, operation);
    const neighbor = await reopened.claimMutation("neighbor-thread", operation);

    // Then: stale ownership is recovered while the neighboring completed claim remains replayable.
    expect(recovered.status).toBe("execute");
    expect(neighbor).toEqual({ status: "replay", output: "neighbor output" });
    await expect(access(staleLock)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serializes concurrent stale-lock recovery across independent processes", async () => {
  // Given: many ready processes and one stale lock for their shared critical section.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-stale-race-"));
  const threadId = "stale-race-thread";
  const staleLock = join(root, `${createHash("sha256").update(threadId).digest("hex")}.lock`);
  const marker = join(root, "critical-section.marker");
  const moduleUrl = new URL("../src/persistence/file-lock.ts", import.meta.url).href;
  const script = `
    const { open, unlink } = await import("node:fs/promises");
    const { withCheckpointFileLock } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write("ready\\n");
    await Bun.stdin.text();
    await withCheckpointFileLock(process.argv[1], process.argv[2], async () => {
      let handle;
      try {
        handle = await open(process.argv[3], "wx", 0o600);
      } catch (error) {
        process.stderr.write("critical-section-overlap\\n");
        process.exitCode = 2;
        return;
      }
      try {
        await Bun.sleep(40);
      } finally {
        await handle.close();
        await unlink(process.argv[3]);
      }
    });
    process.stdout.write("done\\n");
  `;

  try {
    await writeFile(
      staleLock,
      `${JSON.stringify({ version: 1, threadId, pid: 2_147_483_647, startedAt: 0, nonce: "dead-race-owner", hostname: hostname() })}\n`,
      { mode: 0o600 },
    );
    const contenders = Array.from({ length: 12 }, () => spawnLockContender(script, root, threadId, marker));
    const ready = await Promise.all(contenders.map(({ reader }) => reader.read()));
    expect(ready.every(({ value }) => new TextDecoder().decode(value).includes("ready"))).toBe(true);

    // When: every process attempts stale recovery at once.
    for (const contender of contenders) {
      contender.process.stdin.write("go\n");
      contender.process.stdin.end();
    }
    const [exitCodes, errors] = await Promise.all([
      Promise.all(contenders.map(({ process: child }) => child.exited)),
      Promise.all(contenders.map(({ errorReader }) => readRemaining(errorReader))),
    ]);

    // Then: all critical sections complete without an overlap detector firing.
    expect(exitCodes).toEqual(Array.from({ length: contenders.length }, () => 0));
    expect(errors.join("")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("recovers a reused PID lock with a changed process-start identity", async () => {
  // Given: this live PID recorded with its exact lock timestamp but a changed Linux start identity.
  const root = await mkdtemp(join(tmpdir(), "pi-langgraph-pid-reuse-"));
  const threadId = "reused-pid-thread";
  const path = join(root, `${createHash("sha256").update(threadId).digest("hex")}.lock`);
  let captured = "";

  try {
    await withCheckpointFileLock(root, threadId, async () => {
      captured = await readFile(path, "utf8");
    });
    const owner: unknown = JSON.parse(captured);
    if (!isRecord(owner) || typeof owner.processStartIdentity !== "string") {
      throw new Error("lock owner did not record its Linux process-start identity");
    }
    const changedIdentity = owner.processStartIdentity === "0" ? "1" : "0";
    await writeFile(path, `${JSON.stringify({ ...owner, nonce: "reused-pid", processStartIdentity: changedIdentity })}\n`);

    // When: the current process encounters the record for its reused PID.
    let entered = false;
    await withCheckpointFileLock(root, threadId, async () => {
      entered = true;
    });

    // Then: differing process-start identity makes the prior owner stale.
    expect(entered).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function spawnContender(script: string, root: string, threadId: string) {
  const child = Bun.spawn([process.execPath, "-e", script, root, threadId], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { process: child, reader: child.stdout.getReader() };
}

function spawnLockContender(script: string, root: string, threadId: string, marker: string) {
  const child = Bun.spawn([process.execPath, "-e", script, root, threadId, marker], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { process: child, reader: child.stdout.getReader(), errorReader: child.stderr.getReader() };
}

async function readRemaining(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return output;
    output += new TextDecoder().decode(chunk.value);
  }
}

function claimStatus(output: string): string {
  const lastLine = output.trim().split("\n").at(-1);
  const value: unknown = JSON.parse(lastLine ?? "null");
  if (!isRecord(value) || typeof value.status !== "string") throw new Error(`invalid contender output: ${output}`);
  return value.status;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createHash, randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "./file-checkpoint-format.ts";
import { isNodeErrorCode } from "./checkpoint-file-io.ts";

const LOCK_VERSION = 1 as const;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 20;
const PROCESS_STARTED_AT = Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000));

interface LockOwner {
  readonly version: typeof LOCK_VERSION;
  readonly threadId: string;
  readonly pid: number;
  readonly startedAt: number;
  readonly nonce: string;
  readonly hostname: string;
  readonly processStartIdentity?: string;
}

export class CheckpointLockTimeoutError extends Error {
  readonly threadId: string;

  constructor(threadId: string) {
    super(`timed out waiting for checkpoint lock for thread ${JSON.stringify(threadId)}`);
    this.name = "CheckpointLockTimeoutError";
    this.threadId = threadId;
  }
}

export async function withCheckpointFileLock<T>(
  directory: string,
  threadId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = lockPath(directory, threadId);
  const processStartIdentity = await readLinuxProcessStartIdentity(process.pid);
  const owner: LockOwner = {
    version: LOCK_VERSION,
    threadId,
    pid: process.pid,
    startedAt: PROCESS_STARTED_AT,
    nonce: randomUUID(),
    hostname: hostname(),
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
  };
  await acquire(path, owner);
  try {
    return await operation();
  } finally {
    await release(path, owner);
  }
}

function lockPath(directory: string, threadId: string): string {
  return join(directory, `${createHash("sha256").update(threadId).digest("hex")}.lock`);
}

async function acquire(path: string, owner: LockOwner): Promise<void> {
  const deadline = performance.now() + LOCK_WAIT_MS;
  while (true) {
    if (await tryCreate(path, owner)) return;
    if (await removeDeadSameHostOwner(path, owner.threadId)) continue;
    if (performance.now() >= deadline) throw new CheckpointLockTimeoutError(owner.threadId);
    await delay(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - performance.now())));
  }
}

async function tryCreate(path: string, owner: LockOwner): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
  } catch (error) {
    if (isNodeErrorCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    try {
      await unlink(path);
    } catch (cleanupError) {
      if (!isNodeErrorCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  } finally {
    await handle.close();
  }
  return true;
}

async function removeDeadSameHostOwner(path: string, threadId: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return true;
    throw error;
  }
  const owner = parseOwner(raw);
  if (owner === undefined || owner.threadId !== threadId || owner.hostname !== hostname()) return false;
  if (!(await isDeadOrReusedProcess(owner))) return false;
  const recoveryClaim = `${path}.recover-${createHash("sha256").update(owner.nonce).digest("hex")}`;
  try {
    await link(path, recoveryClaim);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "EEXIST")) return true;
    throw error;
  }
  try {
    const claimedOwner = parseOwner(await readFile(recoveryClaim, "utf8"));
    if (claimedOwner?.nonce !== owner.nonce) return true;
    const quarantine = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return true;
      throw error;
    }
    try {
      await unlink(quarantine);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
    return true;
  } finally {
    try {
      await unlink(recoveryClaim);
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
  }
}

async function release(path: string, owner: LockOwner): Promise<void> {
  let current: LockOwner | undefined;
  try {
    current = parseOwner(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (current?.nonce !== owner.nonce) return;
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
}

function parseOwner(raw: string): LockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== LOCK_VERSION ||
    typeof value.threadId !== "string" ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.startedAt !== "number" ||
    !Number.isSafeInteger(value.startedAt) ||
    value.startedAt < 0 ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    value.nonce.length > 128 ||
    typeof value.hostname !== "string" ||
    value.hostname.length === 0 ||
    (value.processStartIdentity !== undefined &&
      (typeof value.processStartIdentity !== "string" || !/^\d+$/.test(value.processStartIdentity)))
  ) return undefined;
  return {
    version: LOCK_VERSION,
    threadId: value.threadId,
    pid: value.pid,
    startedAt: value.startedAt,
    nonce: value.nonce,
    hostname: value.hostname,
    ...(value.processStartIdentity === undefined ? {} : { processStartIdentity: value.processStartIdentity }),
  };
}

async function isDeadOrReusedProcess(owner: LockOwner): Promise<boolean> {
  const currentIdentity = await readLinuxProcessStartIdentity(owner.pid);
  if (owner.processStartIdentity !== undefined && currentIdentity !== undefined) {
    return owner.processStartIdentity !== currentIdentity;
  }
  return !isProcessAlive(owner.pid);
}

async function readLinuxProcessStartIdentity(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  let stat: string;
  try {
    stat = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (
      isNodeErrorCode(error, "ENOENT") ||
      isNodeErrorCode(error, "ESRCH") ||
      isNodeErrorCode(error, "EACCES") ||
      isNodeErrorCode(error, "EPERM")
    ) return undefined;
    throw error;
  }
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  const startIdentity = stat.slice(commandEnd + 2).trim().split(/\s+/)[19];
  return startIdentity !== undefined && /^\d+$/.test(startIdentity) ? startIdentity : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    if (isNodeErrorCode(error, "EPERM")) return true;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

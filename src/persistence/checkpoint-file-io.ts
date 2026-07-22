import { chmod, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_CHECKPOINT_FILE_BYTES, isRecord } from "./file-checkpoint-format.ts";

export async function readBoundedFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const file = await handle.stat();
    if (!file.isFile()) throw new Error(`checkpoint path is not a regular file: ${path}`);
    if (file.size > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(`checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${path}`);
    }
    const buffer = Buffer.alloc(file.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CHECKPOINT_FILE_BYTES) {
      throw new Error(`checkpoint file exceeds ${MAX_CHECKPOINT_FILE_BYTES} bytes: ${path}`);
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function atomicWrite(directory: string, destination: string, contents: string): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isNodeErrorCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

export function isNodeErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code;
}

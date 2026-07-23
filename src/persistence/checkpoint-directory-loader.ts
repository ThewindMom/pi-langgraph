import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { FILE_SUFFIX } from "./file-checkpoint-format.ts";

export type QuarantinedCheckpoint = Readonly<{
  sourceName: string;
  quarantineName: string;
  error: string;
}>;

export async function initializeCheckpointDirectory(
  rootDirectory: string,
  loadFile: (fileName: string) => Promise<void>,
): Promise<readonly QuarantinedCheckpoint[]> {
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(rootDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`checkpoint root must be a real directory: ${rootDirectory}`);
  }
  await chmod(rootDirectory, 0o700);
  const quarantined: QuarantinedCheckpoint[] = [];
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX)) continue;
    try {
      await loadFile(entry.name);
    } catch (error) {
      const quarantineName = `${entry.name}.corrupt-${randomUUID()}`;
      await rename(join(rootDirectory, entry.name), join(rootDirectory, quarantineName));
      await chmod(join(rootDirectory, quarantineName), 0o600);
      const message = error instanceof Error ? error.message : "checkpoint load failed with a non-Error value";
      quarantined.push({ sourceName: entry.name, quarantineName, error: message });
    }
  }
  return quarantined;
}

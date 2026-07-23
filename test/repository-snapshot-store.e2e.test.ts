import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RepositorySnapshotStore,
  RepositorySnapshotStoreError,
} from "../src/repository/repository-snapshot-store.ts";

describe("RepositorySnapshotStore", () => {
  test("materializes dirty tracked and untracked state without changing source Git state", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-dirty-"));
    const repository = join(root, "repository");
    const managerRoot = join(root, "managed");
    const destination = join(managerRoot, "candidate-0");
    try {
      await initializeRepository(repository);
      await writeFile(join(repository, "tracked.txt"), Buffer.from([0, 1, 2, 255]));
      await chmod(join(repository, "script.sh"), 0o755);
      await rm(join(repository, "deleted.txt"));
      await mkdir(join(repository, "nested"));
      await writeFile(join(repository, "nested", "untracked.bin"), Buffer.from([255, 0, 128, 10]));
      const headBefore = git(repository, ["rev-parse", "HEAD"]);
      const countBefore = git(repository, ["rev-list", "--count", "HEAD"]);
      const statusBefore = git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]);
      const store = await RepositorySnapshotStore.open(join(root, "data"));

      // When
      const snapshot = await store.capture(repository);
      await mkdir(destination, { recursive: true });
      const restarted = await RepositorySnapshotStore.open(join(root, "data"));
      await restarted.materialize(snapshot.snapshotId, {
        kind: "empty-directory",
        managerRoot,
        destination,
      });

      // Then
      expect(snapshot.baselineHead).toBe(headBefore.trim());
      expect(await readFile(join(destination, "tracked.txt"))).toEqual(Buffer.from([0, 1, 2, 255]));
      expect(await readFile(join(destination, "nested", "untracked.bin"))).toEqual(Buffer.from([255, 0, 128, 10]));
      expect((await Bun.file(join(destination, "script.sh")).stat()).mode & 0o111).not.toBe(0);
      expect(await Bun.file(join(destination, "deleted.txt")).exists()).toBe(false);
      expect(await restarted.verifyMaterialized(snapshot.snapshotId, destination)).toBe(true);
      expect(git(repository, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(git(repository, ["rev-list", "--count", "HEAD"])).toBe(countBefore);
      expect(git(repository, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("captures and restores an unborn HEAD", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-unborn-"));
    const repository = join(root, "repository");
    const managerRoot = join(root, "managed");
    const destination = join(managerRoot, "candidate-0");
    try {
      await mkdir(repository);
      git(repository, ["init"]);
      await writeFile(join(repository, "draft.txt"), "uncommitted beginning\n");
      const store = await RepositorySnapshotStore.open(join(root, "data"));

      // When
      const snapshot = await store.capture(repository);
      await mkdir(destination, { recursive: true });
      await store.materialize(snapshot.snapshotId, {
        kind: "empty-directory",
        managerRoot,
        destination,
      });

      // Then
      expect(snapshot.baselineHead).toBeNull();
      expect(await readFile(join(destination, "draft.txt"), "utf8")).toBe("uncommitted beginning\n");
      expect(gitResult(repository, ["rev-parse", "HEAD"]).exitCode).not.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("materializes deletions into a clean manager-owned worktree", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-worktree-"));
    const repository = join(root, "repository");
    const managerRoot = join(root, "managed");
    const destination = join(managerRoot, "candidate-0");
    try {
      await initializeRepository(repository);
      await writeFile(join(repository, "tracked.txt"), "dirty tracked\n");
      await writeFile(join(repository, "untracked.txt"), "untracked\n");
      await rm(join(repository, "deleted.txt"));
      const store = await RepositorySnapshotStore.open(join(root, "data"));
      const snapshot = await store.capture(repository);
      await mkdir(managerRoot);
      git(repository, ["worktree", "add", destination, "HEAD"]);

      // When
      await store.materialize(snapshot.snapshotId, {
        kind: "managed-worktree",
        managerRoot,
        destination,
      });

      // Then
      expect(await readFile(join(destination, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
      expect(await readFile(join(destination, "untracked.txt"), "utf8")).toBe("untracked\n");
      expect(await Bun.file(join(destination, "deleted.txt")).exists()).toBe(false);
      expect(await store.verifyMaterialized(snapshot.snapshotId, destination)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a capture race without publishing a manifest", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-race-"));
    const repository = join(root, "repository");
    try {
      await initializeRepository(repository);
      const changingPath = join(repository, "changing.bin");
      await writeFile(changingPath, Buffer.alloc(8 * 1024 * 1024, 1));
      const store = await RepositorySnapshotStore.open(join(root, "data"));
      let keepChanging = true;
      const mutation = (async () => {
        let byte = 2;
        while (keepChanging) {
          await writeFile(changingPath, Buffer.alloc(8 * 1024 * 1024, byte));
          byte = byte === 2 ? 3 : 2;
        }
      })();

      // When
      const capture = store.capture(repository);

      // Then
      await expect(capture).rejects.toBeInstanceOf(RepositorySnapshotStoreError);
      try {
        await capture;
      } catch (error) {
        expect(error).toBeInstanceOf(RepositorySnapshotStoreError);
        if (error instanceof RepositorySnapshotStoreError) expect(error.code).toBe("source-changed");
      } finally {
        keepChanging = false;
        await mutation;
      }
      expect(await manifestNames(join(root, "data", "repository-snapshots", "manifests"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects symlink capture and non-empty materialization targets", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-boundary-"));
    const repository = join(root, "repository");
    const managerRoot = join(root, "managed");
    const destination = join(managerRoot, "candidate-0");
    try {
      await initializeRepository(repository);
      await symlink("tracked.txt", join(repository, "link.txt"));
      const store = await RepositorySnapshotStore.open(join(root, "data"));

      // When / Then
      await expect(store.capture(repository)).rejects.toThrow("symlink");
      await rm(join(repository, "link.txt"));
      const snapshot = await store.capture(repository);
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "user-owned.txt"), "preserve\n");
      await expect(store.materialize(snapshot.snapshotId, {
        kind: "empty-directory",
        managerRoot,
        destination,
      })).rejects.toThrow("empty");
      expect(await readFile(join(destination, "user-owned.txt"), "utf8")).toBe("preserve\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects corrupt blobs after restart", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-corrupt-"));
    const repository = join(root, "repository");
    const managerRoot = join(root, "managed");
    const destination = join(managerRoot, "candidate-0");
    try {
      await initializeRepository(repository);
      const store = await RepositorySnapshotStore.open(join(root, "data"));
      const snapshot = await store.capture(repository);
      const blobRoot = join(root, "data", "repository-snapshots", "blobs");
      const blobs = await readdir(blobRoot);
      const blob = blobs[0];
      if (blob === undefined) throw new Error("fixture snapshot did not create a blob");
      await writeFile(join(blobRoot, blob), "corrupt");
      await mkdir(destination, { recursive: true });

      // When
      const restarted = await RepositorySnapshotStore.open(join(root, "data"));
      const materialization = restarted.materialize(snapshot.snapshotId, {
        kind: "empty-directory",
        managerRoot,
        destination,
      });

      // Then
      await expect(materialization).rejects.toThrow("corrupt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("checks snapshot existence without accepting corrupt manifests", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pi-snapshot-exists-"));
    const repository = join(root, "repository");
    try {
      await initializeRepository(repository);
      const store = await RepositorySnapshotStore.open(join(root, "data"));
      const snapshot = await store.capture(repository);
      const manifest = join(root, "data", "repository-snapshots", "manifests", `${snapshot.snapshotId}.json`);

      // When / Then
      expect(await store.has(snapshot.snapshotId)).toBe(true);
      expect(await store.has("f".repeat(64))).toBe(false);
      await writeFile(manifest, "corrupt");
      await expect(store.has(snapshot.snapshotId)).rejects.toBeInstanceOf(RepositorySnapshotStoreError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository);
  await writeFile(join(repository, "tracked.txt"), "tracked baseline\n");
  await writeFile(join(repository, "script.sh"), "#!/bin/sh\nexit 0\n");
  await writeFile(join(repository, "deleted.txt"), "remove me\n");
  git(repository, ["init"]);
  git(repository, ["config", "user.name", "Pi LangGraph Test"]);
  git(repository, ["config", "user.email", "pi-langgraph@example.invalid"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "fixture"]);
}

function git(cwd: string, args: readonly string[]): string {
  const result = gitResult(cwd, args);
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function gitResult(cwd: string, args: readonly string[]): Readonly<{ exitCode: number; stdout: string; stderr: string }> {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

async function manifestNames(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

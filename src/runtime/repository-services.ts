import { createHash } from "node:crypto";
import { join } from "node:path";
import { ReadOnlyCache, type ReadOnlyOperation } from "../cache/read-only-cache.ts";
import { HostEvidenceRunner } from "../evidence/runner.ts";
import type { ArtifactRef } from "../evidence/types.ts";
import { RepositoryMemory } from "../memory/repository-memory.ts";
import { ArtifactStore } from "../persistence/artifact-store.ts";
import { RetentionIndex } from "../persistence/reachability.ts";
import type { RepositoryCheckpointIdentity } from "../persistence/checkpoint-thread-codec.ts";
import { createRepositorySnapshot, type RepositorySnapshot } from "../repository/snapshot.ts";
import { runInIsolatedRepository } from "../repository/mutation-scope.ts";
import { validateMutationOutput } from "./mutation-output.ts";
import type { ExecutionRequest, TaskExecutor, TaskResult } from "../types.ts";
import type { CodingRunResult } from "../workflow/types.ts";
import type { CheckpointTuple } from "@langchain/langgraph-checkpoint";

const CACHE_PROTOCOL = "pi-langgraph.worker.v1";
const MEMORY_KEY = "completed-summary";
export type RepositoryExecutionPolicy = Readonly<{
  adapter: "native" | "sdk";
  inheritedModel: Readonly<{ provider: string; id: string; api: string }> | null;
  activeTools: readonly string[];
  protocol: string;
}>;
export type RepositoryServicesOptions = Readonly<{
  executor: TaskExecutor;
  policy: RepositoryExecutionPolicy;
  threadId?: string;
}>;
export class RepositoryServices {
  readonly snapshot: RepositorySnapshot;
  readonly artifacts: ArtifactStore;
  readonly evidenceRunner: HostEvidenceRunner;
  readonly executor: TaskExecutor;
  private constructor(
    private readonly cwd: string,
    snapshot: RepositorySnapshot,
    artifacts: ArtifactStore,
    private readonly cache: ReadOnlyCache,
    private readonly memory: RepositoryMemory,
    private readonly retention: RetentionIndex,
    private readonly policy: RepositoryExecutionPolicy,
    private readonly activeOwner: string | undefined,
    executor: TaskExecutor,
  ) {
    this.snapshot = snapshot;
    this.artifacts = artifacts;
    const artifactStore = activeOwner === undefined
      ? artifacts
      : { put: (content: string | Uint8Array) => artifacts.putOwned(activeOwner, content) };
    this.evidenceRunner = new HostEvidenceRunner({ cwd, artifactStore });
    this.executor = this.cachedExecutor(executor);
  }
  static async open(
    dataRoot: string,
    cwd: string,
    executorOrOptions: TaskExecutor | RepositoryServicesOptions,
  ): Promise<RepositoryServices> {
    const options = "execute" in executorOrOptions
      ? { executor: executorOrOptions, policy: legacyPolicy() }
      : executorOrOptions;
    const snapshot = await createRepositorySnapshot(cwd);
    const repositoryId = digest(snapshot.repositoryRoot);
    const root = join(dataRoot, "repositories", repositoryId);
    const [artifacts, cache, memory, retention] = await Promise.all([
      ArtifactStore.open(join(root, "artifacts")),
      ReadOnlyCache.open(join(root, "cache")),
      RepositoryMemory.open(join(root, "memory")),
      RetentionIndex.open(join(root, "retention")),
    ]);
    const activeOwner = options.threadId === undefined ? undefined : `active:${options.threadId}`;
    return new RepositoryServices(
      cwd, snapshot, artifacts, cache, memory, retention, options.policy, activeOwner, options.executor,
    );
  }

  bindCheckpoint(
    checkpointer: { bindRepositorySnapshot(threadId: string, identity: RepositoryCheckpointIdentity): void },
    threadId: string,
  ): void {
    checkpointer.bindRepositorySnapshot(threadId, {
      protocolVersion: 1,
      snapshotId: this.snapshot.snapshotId,
      head: this.snapshot.head,
    });
  }

  async recordResult(result: CodingRunResult, checkpointId: string, tuple?: CheckpointTuple): Promise<void> {
    const refs = result.status === "awaiting_approval"
      ? checkpointRefs(tuple)
      : normalizeRefs(result.evidenceRefs);
    const updates = [
      { owner: { kind: "thread" as const, id: result.threadId }, refs },
      { owner: { kind: "checkpoint" as const, id: digest(checkpointId) }, refs },
      ...mutationOwners(result.threadId, tuple, refs),
      ...(result.status === "awaiting_approval"
        ? [{ owner: { kind: "interrupt" as const, id: result.threadId }, refs }]
        : []),
    ];
    const releases = result.status === "awaiting_approval"
      ? []
      : [{ kind: "interrupt" as const, id: result.threadId }];
    await this.retention.reconcile(updates, releases);
    if (this.activeOwner !== undefined) await this.artifacts.unpin(this.activeOwner);
    if (result.status === "completed") {
      const postRunSnapshot = await createRepositorySnapshot(this.cwd);
      await this.memory.put(postRunSnapshot, MEMORY_KEY, result.summary, {
        sourceCheckpointId: checkpointId,
        artifactRefs: refs,
        observedAt: new Date().toISOString(),
        schemaVersion: 1,
        confidence: 1,
      });
    }
    await this.retention.compact(this.artifacts);
  }

  async retainFork(forkThreadId: string, refs: readonly ArtifactRef[]): Promise<void> {
    await this.retention.pin({ kind: "fork", id: forkThreadId }, normalizeRefs(refs));
  }

  private cachedExecutor(delegate: TaskExecutor): TaskExecutor {
    return {
      execute: async (request, signal, options) => {
        const operation = cacheOperation(request.task.id);
        const readOnly = !isMutationTask(request.task.id);
        if (operation === undefined && !readOnly) {
          return runInIsolatedRepository(
            this.snapshot.repositoryRoot,
            this.cwd,
            { kind: "mutation", allowedFiles: request.task.allowedFiles },
            (workingDirectory) => delegate.execute(request, signal, { ...options, workingDirectory }),
            (output, changedPaths) => validateMutationOutput(
              output, changedPaths, request.task.id, request.task.allowedFiles,
            ),
          );
        }
        if (operation === undefined) {
          return runInIsolatedRepository(
            this.snapshot.repositoryRoot,
            this.cwd,
            { kind: "read-only" },
            (workingDirectory) => delegate.execute(request, signal, { ...options, workingDirectory }),
          );
        }
        const before = await createRepositorySnapshot(this.cwd);
        const key = {
          snapshotId: before.snapshotId,
          operation,
          inputHash: requestHash(request),
          policyHash: policyHash(this.policy, request),
        };
        const hit = await this.cache.get(key);
        if (hit !== undefined) return new TextDecoder().decode(await this.artifacts.get(normalizeRef(hit)));
        const enriched = await this.withMemory(request);
        const output = await runInIsolatedRepository(
          this.snapshot.repositoryRoot,
          this.cwd,
          { kind: "read-only" },
          (workingDirectory) => delegate.execute(enriched, signal, { ...options, workingDirectory }),
        );
        const artifact = await this.artifacts.putOwned(`cache:${digest(output)}`, output);
        await this.cache.set(key, artifact, { protocol: CACHE_PROTOCOL });
        return output;
      },
    };
  }

  private async withMemory(request: ExecutionRequest): Promise<ExecutionRequest> {
    const fact = await this.memory.get(this.snapshot, MEMORY_KEY);
    if (fact === undefined) return request;
    const now = new Date().toISOString();
    const dependency: TaskResult = {
      id: "repository_memory_exact_snapshot_untrusted",
      status: "completed",
      output: JSON.stringify({ trust: "untrusted_dependency_context", fact }),
      startedAt: now,
      completedAt: now,
    };
    return { ...request, dependencyResults: [...request.dependencyResults, dependency] };
  }
}

function cacheOperation(taskId: string): ReadOnlyOperation | undefined {
  if (taskId === "discover") return "discovery";
  return /^specialist_[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId) ? "specialist" : undefined;
}

function isMutationTask(taskId: string): boolean {
  return taskId === "implement" || taskId === "repair" || /^(?:implement|repair)_[A-Za-z][A-Za-z0-9_-]{0,47}$/.test(taskId);
}

function requestHash(request: ExecutionRequest): string {
  return digest(JSON.stringify({
    prompt: request.task.prompt,
  }));
}

function policyHash(policy: RepositoryExecutionPolicy, request: ExecutionRequest): string {
  return digest(JSON.stringify({
    adapter: policy.adapter,
    inheritedModel: policy.inheritedModel,
    activeTools: [...new Set(policy.activeTools)].sort(),
    taskAgent: request.task.agent ?? null,
    taskModel: request.task.model ?? null,
    protocol: policy.protocol,
  }));
}

function checkpointRefs(tuple: CheckpointTuple | undefined): readonly ArtifactRef[] {
  return artifactRefs(tuple?.checkpoint.channel_values.evidenceRefs);
}

function artifactRefs(value: unknown): readonly ArtifactRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref) => {
    if (typeof ref !== "object" || ref === null || !("digest" in ref) || typeof ref.digest !== "string" ||
      !("byteCount" in ref) || typeof ref.byteCount !== "number" || !("truncated" in ref) || typeof ref.truncated !== "boolean") return [];
    return [{ digest: ref.digest, byteCount: ref.byteCount, truncated: ref.truncated }];
  });
}

function mutationOwners(
  threadId: string,
  tuple: CheckpointTuple | undefined,
  fallbackRefs: readonly ArtifactRef[],
): readonly { readonly owner: { readonly kind: "mutation"; readonly id: string }; readonly refs: readonly ArtifactRef[] }[] {
  const value = tuple?.checkpoint.channel_values.changeResults;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("changeId" in item) || typeof item.changeId !== "string" ||
      !("attempt" in item) || typeof item.attempt !== "number") return [];
    const evidence = "evidenceRefs" in item && Array.isArray(item.evidenceRefs)
      ? artifactRefs(item.evidenceRefs)
      : fallbackRefs;
    return [{ owner: { kind: "mutation", id: digest(`${threadId}\0${item.changeId}\0${item.attempt}`) }, refs: evidence }];
  });
}

function legacyPolicy(): RepositoryExecutionPolicy {
  return { adapter: "sdk", inheritedModel: null, activeTools: [], protocol: CACHE_PROTOCOL };
}

function normalizeRefs(refs: readonly ArtifactRef[]): readonly ArtifactRef[] {
  return refs.map(normalizeRef);
}

function normalizeRef(ref: { readonly digest: string; readonly byteCount: number; readonly truncated?: boolean }): ArtifactRef {
  return { digest: ref.digest, byteCount: ref.byteCount, truncated: ref.truncated === true };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

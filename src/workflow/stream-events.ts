import type { ArtifactRef } from "../evidence/types.ts";

export type WorkflowEventKind = "update" | "custom" | "task" | "checkpoint" | "terminal";
export type WorkflowTerminalStatus = "awaiting_approval" | "completed" | "needs_attention";

type EventIdentity = {
  readonly runId: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly namespace: string;
};

type EventBase = EventIdentity & {
  readonly detail: string;
  readonly artifactRefs: readonly ArtifactRef[];
  readonly changeId?: string;
};

export type WorkflowEvent =
  | (EventBase & { readonly kind: "update"; readonly nodeId: string })
  | (EventBase & { readonly kind: "custom" })
  | (EventBase & {
      readonly kind: "task";
      readonly taskId: string;
      readonly nodeId: string;
      readonly phase: "start" | "finish";
    })
  | (EventBase & {
      readonly kind: "checkpoint";
      readonly checkpointId: string;
      readonly parentCheckpointId?: string;
      readonly nodeId?: string;
    })
  | (EventBase & { readonly kind: "terminal"; readonly status: WorkflowTerminalStatus });

export type StreamProjectionContext = {
  readonly runId: string;
  readonly threadId: string;
  readonly sequence: number;
};

const MAX_DETAIL_LENGTH = 8_000;
const MAX_NAMESPACE_LENGTH = 1_000;
const MAX_NODE_ID_LENGTH = 200;
const MAX_ARTIFACT_REFS = 16;
const MAX_SEARCH_VALUES = 512;

export function projectStreamEvents(
  context: StreamProjectionContext,
  chunk: unknown,
): readonly WorkflowEvent[] {
  if (!Array.isArray(chunk) || chunk.length !== 3) return [];
  const [rawNamespace, rawMode, payload] = chunk;
  const identity = {
    runId: context.runId,
    threadId: context.threadId,
    sequence: context.sequence,
    namespace: namespaceValue(rawNamespace),
  };
  switch (rawMode) {
    case "updates":
      return updateEvents(identity, payload);
    case "custom":
      return [{ ...identity, kind: "custom", detail: boundedJson(payload), artifactRefs: artifactRefs(payload), ...changeIdentity(payload) }];
    case "tasks":
      return taskEvents(identity, payload);
    case "checkpoints":
      return checkpointEvents(identity, payload);
    default:
      return [];
  }
}

export function terminalEvent(
  context: StreamProjectionContext,
  status: WorkflowTerminalStatus,
  refs: readonly ArtifactRef[],
): WorkflowEvent {
  return {
    ...context,
    namespace: "root",
    kind: "terminal",
    status,
    detail: status,
    artifactRefs: refs.slice(0, MAX_ARTIFACT_REFS),
  };
}

function updateEvents(identity: EventIdentity, payload: unknown): readonly WorkflowEvent[] {
  if (!isRecord(payload)) return [];
  return Object.entries(payload)
    .filter(([nodeId]) => nodeId !== "__metadata__")
    .map(([nodeId, update], index) => ({
      ...identity,
      sequence: identity.sequence + index,
      kind: "update" as const,
      nodeId: boundedNodeId(nodeId),
      detail: boundedJson(update),
      artifactRefs: artifactRefs(update),
      ...changeIdentity(update),
    }));
}

function taskEvents(identity: EventIdentity, payload: unknown): readonly WorkflowEvent[] {
  if (!isRecord(payload) || typeof payload.id !== "string" || typeof payload.name !== "string") return [];
  const completed = Object.prototype.hasOwnProperty.call(payload, "result");
  const detailValue = completed ? payload.result : payload.input;
  return [{
    ...identity,
    kind: "task",
    taskId: payload.id.slice(0, MAX_NODE_ID_LENGTH),
    nodeId: boundedNodeId(payload.name),
    phase: completed ? "finish" : "start",
    detail: boundedJson(detailValue),
    artifactRefs: artifactRefs(detailValue),
    ...changeIdentity(detailValue),
  }];
}

function checkpointEvents(identity: EventIdentity, payload: unknown): readonly WorkflowEvent[] {
  if (!isRecord(payload)) return [];
  const checkpointId = configurableId(payload.config, "checkpoint_id");
  if (checkpointId === undefined) return [];
  const parentCheckpointId = configurableId(payload.parentConfig, "checkpoint_id");
  const nodeId = checkpointNodeId(payload);
  const values = payload.values;
  return [{
    ...identity,
    kind: "checkpoint",
    checkpointId,
    ...(parentCheckpointId === undefined ? {} : { parentCheckpointId }),
    ...(nodeId === undefined ? {} : { nodeId }),
    detail: boundedJson({ metadata: payload.metadata, next: payload.next }),
    artifactRefs: artifactRefs(values),
    ...changeIdentity(values),
  }];
}

function checkpointNodeId(payload: Readonly<Record<string, unknown>>): string | undefined {
  if (Array.isArray(payload.next)) {
    const next = payload.next.find((value): value is string => typeof value === "string");
    if (next !== undefined) return boundedNodeId(next);
  }
  if (!Array.isArray(payload.tasks)) return undefined;
  for (const task of payload.tasks) {
    if (isRecord(task) && typeof task.name === "string") return boundedNodeId(task.name);
  }
  return undefined;
}

function configurableId(value: unknown, field: string): string | undefined {
  if (!isRecord(value) || !isRecord(value.configurable)) return undefined;
  const id = value.configurable[field];
  return typeof id === "string" ? id.slice(0, MAX_NODE_ID_LENGTH) : undefined;
}

function namespaceValue(value: unknown): string {
  if (!Array.isArray(value)) return "root";
  const parts = value.filter((part): part is string => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? "root" : parts.join("/").slice(0, MAX_NAMESPACE_LENGTH);
}

function boundedNodeId(value: string): string {
  return value.slice(0, MAX_NODE_ID_LENGTH);
}

function boundedJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "string") return current.slice(0, 2_000);
    if (typeof current === "bigint") return current.toString();
    if (typeof current !== "object" || current === null) return current;
    if (seen.has(current)) return "[Circular]";
    seen.add(current);
    if (Array.isArray(current)) return current.slice(0, 32);
    return Object.fromEntries(Object.entries(current).slice(0, 32));
  });
  const detail = encoded ?? "null";
  if (detail.length <= MAX_DETAIL_LENGTH) return detail;
  return JSON.stringify({ truncated: true, preview: detail.slice(0, MAX_DETAIL_LENGTH - 40) });
}

function artifactRefs(value: unknown): readonly ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  const seenRefs = new Set<string>();
  const seenValues = new WeakSet<object>();
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && refs.length < MAX_ARTIFACT_REFS && visited < MAX_SEARCH_VALUES) {
    visited += 1;
    const current = pending.pop();
    if (isArtifactRef(current)) {
      const key = `${current.digest}:${current.byteCount}:${current.truncated}`;
      if (!seenRefs.has(key)) {
        seenRefs.add(key);
        refs.push(current);
      }
      continue;
    }
    if (typeof current !== "object" || current === null || seenValues.has(current)) continue;
    seenValues.add(current);
    pending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  return refs;
}

function changeIdentity(value: unknown): { readonly changeId?: string } {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0 && visited < MAX_SEARCH_VALUES) {
    visited += 1;
    const current = pending.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    if (typeof current.changeId === "string") return { changeId: current.changeId.slice(0, MAX_NODE_ID_LENGTH) };
    pending.push(...Object.values(current));
  }
  return {};
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return isRecord(value) && typeof value.digest === "string" && value.digest.length === 64 &&
    typeof value.byteCount === "number" && Number.isSafeInteger(value.byteCount) &&
    value.byteCount >= 0 && typeof value.truncated === "boolean";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

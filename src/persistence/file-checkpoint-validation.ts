import {
  boundedEntries,
  isRecord,
  MAX_NAMESPACES,
  validateStorageKey,
} from "./file-checkpoint-format.ts";
import { validatePersistedWorkflowChannels } from "./workflow-state-validation.ts";

export function validateCheckpoint(
  value: unknown,
  namespace: string,
  checkpointId: string,
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    typeof value.v !== "number" ||
    !Number.isInteger(value.v) ||
    value.v < 1 ||
    value.v > 4 ||
    typeof value.id !== "string" ||
    value.id !== checkpointId ||
    value.id.length === 0 ||
    value.id.length > 2_048 ||
    typeof value.ts !== "string" ||
    value.ts.length > 128 ||
    !isRecord(value.channel_values) ||
    !isRecord(value.channel_versions) ||
    !isRecord(value.versions_seen)
  ) {
    throw new Error("invalid deserialized checkpoint");
  }
  boundedEntries(value.channel_values, "checkpoint channels", 512, "deserialized checkpoint");
  const channelVersions = boundedEntries(
    value.channel_versions,
    "checkpoint channel versions",
    512,
    "deserialized checkpoint",
  );
  for (const [, version] of channelVersions) validateChannelVersion(version);
  const seen = boundedEntries(value.versions_seen, "checkpoint versions_seen", 512, "deserialized checkpoint");
  for (const [, versions] of seen) {
    for (const [, version] of boundedEntries(versions, "checkpoint seen versions", 512, "deserialized checkpoint")) {
      validateChannelVersion(version);
    }
  }
  if (namespace === "") validatePersistedWorkflowChannels(value.channel_values);
  return value.channel_values;
}

function validateChannelVersion(value: unknown): void {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("invalid deserialized checkpoint channel version");
  }
}

export function validateCheckpointMetadata(value: unknown): void {
  if (
    !isRecord(value) ||
    (value.source !== "input" && value.source !== "loop" && value.source !== "update" && value.source !== "fork") ||
    typeof value.step !== "number" ||
    !Number.isInteger(value.step) ||
    !isRecord(value.parents)
  ) {
    throw new Error("invalid deserialized checkpoint metadata");
  }
  for (const [namespace, checkpointId] of boundedEntries(
    value.parents,
    "checkpoint metadata parents",
    MAX_NAMESPACES,
    "deserialized metadata",
  )) {
    validateStorageKey(namespace, "metadata namespace", "deserialized metadata");
    if (typeof checkpointId !== "string") throw new Error("invalid checkpoint metadata parent");
    validateStorageKey(checkpointId, "metadata checkpoint id", "deserialized metadata");
  }
}

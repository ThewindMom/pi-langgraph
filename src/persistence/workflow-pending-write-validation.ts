import {
  isPersistedWorkflowChannel,
  validatePersistedWorkflowWrite,
} from "./workflow-state-validation.ts";

const APPEND_CHANNELS = new Set(["findings", "changes", "unresolvedRisks", "trace", "changeResults", "evidenceRefs"]);
const OPTIONAL_APPEND_CHANNELS = new Set(["changeResults", "evidenceRefs"]);

export interface PersistedWorkflowWrite {
  readonly channel: string;
  readonly value: unknown;
}

export function validateEffectiveWorkflowState(
  baseValue: unknown,
  pendingWrites: readonly PersistedWorkflowWrite[],
): void {
  const workflowWrites = pendingWrites.filter((write) => isPersistedWorkflowChannel(write.channel));
  if (workflowWrites.length === 0) return;
  if (!isRecord(baseValue)) throw new Error("invalid pending workflow checkpoint state");
  const updatesByChannel = new Map<string, unknown[]>();
  for (const write of workflowWrites) {
    validatePersistedWorkflowWrite(write.channel, write.value);
    const updates = updatesByChannel.get(write.channel) ?? [];
    updates.push(write.value);
    updatesByChannel.set(write.channel, updates);
  }

  for (const [channel, updates] of updatesByChannel) {
    if (APPEND_CHANNELS.has(channel)) {
      const current = baseValue[channel];
      const currentValues = current === undefined && OPTIONAL_APPEND_CHANNELS.has(channel) ? [] : current;
      if (!Array.isArray(currentValues) || updates.some((update) => !Array.isArray(update))) {
        throw new Error(`invalid pending workflow reducer value for ${channel}`);
      }
      continue;
    }
    if (updates.length !== 1) throw new Error(`invalid concurrent pending workflow writes for ${channel}`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

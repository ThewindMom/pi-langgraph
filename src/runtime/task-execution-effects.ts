import {
  DEFAULT_AGENT_TOOL,
  type CompatibleExtensionAPI,
} from "../types.ts";
import type { EffectLedger } from "../workflow/effect-ledger.ts";

type TaskEffectAttestation = Readonly<{
  readonly protocolVersion: 1;
  readonly scope: "repository-only";
  readonly reversible: true;
}>;

export type TaskEffectAttestingExtensionAPI = CompatibleExtensionAPI & Readonly<{
  attestTaskExecutionEffects?: (toolName: string) => unknown;
}>;

export const OPAQUE_TASK_EFFECT_LEDGER: EffectLedger = Object.freeze({
  protocolVersion: 1,
  effects: Object.freeze([
    Object.freeze({
      kind: "unknown",
      effectId: "opaque-task-execution",
    }),
  ]),
});

export const REPOSITORY_ONLY_EFFECT_LEDGER: EffectLedger = Object.freeze({
  protocolVersion: 1,
  effects: Object.freeze([
    Object.freeze({
      kind: "repository-write",
      effectId: "workflow-repository-transaction",
      reversible: true,
    }),
  ]),
});

export function taskExecutionEffectLedger(
  pi: TaskEffectAttestingExtensionAPI,
): EffectLedger {
  if (
    pi.executeTool === undefined ||
    !pi.getActiveTools().includes(DEFAULT_AGENT_TOOL)
  ) {
    return OPAQUE_TASK_EFFECT_LEDGER;
  }
  const attestation = pi.attestTaskExecutionEffects?.(DEFAULT_AGENT_TOOL);
  return isRepositoryOnlyAttestation(attestation)
    ? REPOSITORY_ONLY_EFFECT_LEDGER
    : OPAQUE_TASK_EFFECT_LEDGER;
}

function isRepositoryOnlyAttestation(
  value: unknown,
): value is TaskEffectAttestation {
  if (!isRecord(value)) return false;
  const fields = Object.keys(value).sort();
  return (
    fields.length === 3 &&
    fields[0] === "protocolVersion" &&
    fields[1] === "reversible" &&
    fields[2] === "scope" &&
    value.protocolVersion === 1 &&
    value.scope === "repository-only" &&
    value.reversible === true
  );
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { sha256CanonicalJson } from "../bridge/canonical.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_EFFECTS = 256;

type UnknownRecord = Readonly<Record<string, unknown>>;

export type Effect =
  | Readonly<{ kind: "repository-write"; effectId: string; reversible: boolean }>
  | Readonly<{ kind: "external-known"; effectId: string; compensation: "compensated" | "pending" | "noncompensable" }>
  | Readonly<{ kind: "unknown"; effectId: string }>;

export type EffectLedger = Readonly<{ protocolVersion: 1; effects: readonly Effect[] }>;

export type AutomaticBacktrackSafety =
  | Readonly<{ kind: "safe" }>
  | Readonly<{ kind: "blocked_unknown_effect"; effectId: string }>
  | Readonly<{ kind: "blocked_pending_effect"; effectId: string }>
  | Readonly<{ kind: "blocked_noncompensable_effect"; effectId: string }>;

export class EffectLedgerError extends Error {
  readonly name = "EffectLedgerError";
}

export function parseEffectLedger(input: unknown): EffectLedger {
  const record = requireRecord(input, "effect ledger");
  exactFields(record, ["protocolVersion", "effects"]);
  if (record.protocolVersion !== 1) fail("effect ledger protocolVersion must be 1");
  if (!Array.isArray(record.effects) || record.effects.length > MAX_EFFECTS) {
    fail("effect ledger effects must contain at most 256 records");
  }
  const effects = record.effects.map((effect, index) => parseEffect(effect, index));
  const identifiers = new Set<string>();
  for (const effect of effects) {
    if (identifiers.has(effect.effectId)) fail("effect ledger effectId values must be unique");
    identifiers.add(effect.effectId);
  }
  return { protocolVersion: 1, effects };
}

export function effectLedgerDigest(input: EffectLedger): string {
  return sha256CanonicalJson(input);
}

export function assessAutomaticBacktrackSafety(ledger: EffectLedger): AutomaticBacktrackSafety {
  for (const effect of ledger.effects) {
    switch (effect.kind) {
      case "repository-write":
        if (!effect.reversible) return { kind: "blocked_noncompensable_effect", effectId: effect.effectId };
        break;
      case "external-known":
        switch (effect.compensation) {
          case "compensated":
            break;
          case "pending":
            return { kind: "blocked_pending_effect", effectId: effect.effectId };
          case "noncompensable":
            return { kind: "blocked_noncompensable_effect", effectId: effect.effectId };
          default:
            return assertNever(effect.compensation);
        }
        break;
      case "unknown":
        return { kind: "blocked_unknown_effect", effectId: effect.effectId };
      default:
        return assertNever(effect);
    }
  }
  return { kind: "safe" };
}

function parseEffect(input: unknown, index: number): Effect {
  const record = requireRecord(input, `effects[${index}]`);
  const effectId = identifier(record.effectId, `effects[${index}].effectId`);
  switch (record.kind) {
    case "repository-write":
      exactFields(record, ["kind", "effectId", "reversible"]);
      if (typeof record.reversible !== "boolean") fail(`effects[${index}].reversible must be boolean`);
      return { kind: "repository-write", effectId, reversible: record.reversible };
    case "external-known":
      exactFields(record, ["kind", "effectId", "compensation"]);
      return { kind: "external-known", effectId, compensation: compensation(record.compensation, index) };
    case "unknown":
      exactFields(record, ["kind", "effectId"]);
      return { kind: "unknown", effectId };
    default:
      fail(`effects[${index}].kind is unsupported`);
  }
}

function compensation(input: unknown, index: number): "compensated" | "pending" | "noncompensable" {
  switch (input) {
    case "compensated":
    case "pending":
    case "noncompensable":
      return input;
    default:
      fail(`effects[${index}].compensation is unsupported`);
  }
}

function requireRecord(input: unknown, field: string): UnknownRecord {
  if (!isPlainRecord(input)) {
    fail(`${field} must be a plain object`);
  }
  return input;
}

function isPlainRecord(input: unknown): input is UnknownRecord {
  return typeof input === "object" && input !== null && !Array.isArray(input) && Object.getPrototypeOf(input) === Object.prototype;
}

function exactFields(record: UnknownRecord, fields: readonly string[]): void {
  if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
    fail("effect record has unsupported or missing fields");
  }
}

function identifier(input: unknown, field: string): string {
  if (typeof input !== "string" || !IDENTIFIER.test(input)) fail(`${field} must be an identifier`);
  return input;
}

function fail(message: string): never {
  throw new EffectLedgerError(message);
}

function assertNever(value: never): never {
  return fail(`unsupported effect variant ${String(value)}`);
}

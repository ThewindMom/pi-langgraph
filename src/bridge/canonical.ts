import { createHash } from "node:crypto";
import { BridgeContractError } from "./types.ts";

export const MAX_CANONICAL_JSON_BYTES = 65_536;

const MAX_CANONICAL_DEPTH = 32;

type UnknownRecord = Readonly<Record<string, unknown>>;

export function canonicalJson(value: unknown): string {
  const encoded = canonicalize(value, 0);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CANONICAL_JSON_BYTES) {
    fail("canonical-json");
  }
  return encoded;
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalize(value: unknown, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) fail("canonical-json");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical-json");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry, depth + 1)).join(",")}]`;
  if (!isRecord(value)) fail("canonical-json");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], depth + 1)}`).join(",")}}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string): never {
  throw new BridgeContractError("invalid-payload", field);
}

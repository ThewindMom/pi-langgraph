export type ArtifactRef = {
  readonly digest: string;
  readonly byteCount: number;
  readonly truncated: boolean;
};

export type ArtifactManifest = {
  readonly owners: Readonly<Record<string, readonly string[]>>;
};

const digestPattern = /^[a-f0-9]{64}$/;
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 1 * 1024 * 1024;

export function isDigest(value: string): boolean {
  return digestPattern.test(value);
}

export function parseManifest(data: Uint8Array): ArtifactManifest {
  if (data.byteLength > MAX_MANIFEST_BYTES) throw new Error("artifact manifest exceeds size limit");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(data));
  if (typeof parsed !== "object" || parsed === null || !('owners' in parsed)) throw new Error("invalid artifact manifest");
  const ownersValue: unknown = parsed.owners;
  if (typeof ownersValue !== "object" || ownersValue === null || Array.isArray(ownersValue)) throw new Error("invalid artifact manifest");
  const owners: Record<string, readonly string[]> = {};
  for (const [owner, value] of Object.entries(ownersValue)) {
    if (owner.length === 0 || owner.length > 256 || !Array.isArray(value) || value.length > 4096 || !value.every((digest): digest is string => typeof digest === "string" && digestPattern.test(digest))) throw new Error("invalid artifact manifest");
    owners[owner] = value;
  }
  return { owners };
}

export function serializeManifest(manifest: ArtifactManifest): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  if (bytes.byteLength > MAX_MANIFEST_BYTES) throw new Error("artifact manifest exceeds size limit");
  return bytes;
}

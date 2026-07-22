export type ArtifactRef = {
  readonly digest: string;
  readonly byteCount: number;
  readonly truncated: boolean;
};

export interface ArtifactWriter {
  put(content: string | Uint8Array): Promise<ArtifactRef>;
}

export type HostEvidence = {
  readonly script: string;
  readonly packageManager: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdout: ArtifactRef;
  readonly stderr: ArtifactRef;
  readonly passed: boolean;
};

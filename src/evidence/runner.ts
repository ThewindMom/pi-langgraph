import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactWriter, HostEvidence } from "./types.ts";
import { redactOutput } from "./redaction.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = MAX_OUTPUT_BYTES * 2;
const INTEGRATION_SCRIPT_FAMILIES = ["test", "check", "lint", "build"] as const;

type PackageManifest = {
  readonly scripts: Record<string, unknown> | undefined;
  readonly packageManager: string | undefined;
};

type RunnerOptions = {
  readonly cwd: string;
  readonly artifactStore: ArtifactWriter;
};

type CapturedOutput = {
  readonly text: string;
  readonly truncated: boolean;
};

async function capture(stream: AsyncIterable<Uint8Array | string>): Promise<CapturedOutput> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for await (const value of stream) {
    const chunk = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const remaining = MAX_CAPTURE_BYTES - size;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const kept = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
    chunks.push(kept);
    size += kept.byteLength;
    if (kept.byteLength < chunk.byteLength) truncated = true;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const decoded = new TextDecoder().decode(bytes);
  const redacted = redactOutput(decoded);
  const privateKeyStart = redacted.search(/-----BEGIN [^-\r\n]*PRIVATE KEY-----/);
  const safe = privateKeyStart < 0
    ? redacted
    : `${redacted.slice(0, privateKeyStart)}[REDACTED PRIVATE KEY]`;
  const safeBytes = new TextEncoder().encode(safe);
  const bounded = safeBytes.byteLength <= MAX_OUTPUT_BYTES ? safeBytes : safeBytes.slice(0, MAX_OUTPUT_BYTES);
  return {
    text: new TextDecoder().decode(bounded),
    truncated: truncated || size > MAX_OUTPUT_BYTES || safeBytes.byteLength > MAX_OUTPUT_BYTES,
  };
}

async function readManifest(cwd: string): Promise<PackageManifest> {
  const raw: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
  if (!isRecord(raw)) throw new Error("invalid package.json");
  const scripts = raw.scripts;
  const scriptRecord = scripts === undefined ? undefined : isRecord(scripts) ? scripts : undefined;
  if (scripts !== undefined && scriptRecord === undefined) throw new Error("invalid package scripts");
  const packageManager = raw.packageManager;
  if (packageManager !== undefined && typeof packageManager !== "string") throw new Error("invalid package manager");
  return { scripts: scriptRecord, packageManager: typeof packageManager === "string" ? packageManager : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function detectManager(cwd: string, manifest: PackageManifest): Promise<string> {
  if (manifest.packageManager?.startsWith("pnpm@")) return "pnpm";
  if (manifest.packageManager?.startsWith("yarn@")) return "yarn";
  if (manifest.packageManager?.startsWith("npm@")) return "npm";
  if (manifest.packageManager?.startsWith("bun@")) return "bun";
  for (const [file, manager] of [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]] as const) {
    try {
      await access(join(cwd, file));
      return manager;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  }
  return "npm";
}

export class HostEvidenceRunner {
  readonly #cwd: string;
  readonly #artifactStore: ArtifactWriter;

  constructor(options: RunnerOptions) {
    const cwd = resolve(options.cwd);
    if (!cwd.startsWith("/") || cwd.includes("\0")) throw new Error("unsafe cwd");
    this.#cwd = cwd;
    this.#artifactStore = options.artifactStore;
  }

  async defaultIntegrationScripts(): Promise<readonly string[]> {
    const manifest = await readManifest(this.#cwd);
    const scripts = manifest.scripts ?? {};
    return INTEGRATION_SCRIPT_FAMILIES.flatMap((family) => {
      if (typeof scripts[family] === "string") return [family];
      return Object.keys(scripts)
        .filter((script) => script.startsWith(`${family}:`) && typeof scripts[script] === "string")
        .sort();
    });
  }

  async runPackageScript(script: string, signal?: AbortSignal): Promise<HostEvidence> {
    if (!/^[A-Za-z0-9:_@./-]+$/.test(script)) throw new Error("invalid script name");
    const info = await stat(this.#cwd);
    if (!info.isDirectory()) throw new Error("unsafe cwd");
    const manifest = await readManifest(this.#cwd);
    if (!manifest.scripts || typeof manifest.scripts[script] !== "string") throw new Error(`unknown package script: ${script}`);
    const manager = await detectManager(this.#cwd, manifest);
    const started = performance.now();
    const child = spawn(manager, ["run", script], {
      cwd: this.#cwd,
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const completed = new Promise<Readonly<{ code: number | null; signal: string | null }>>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
    });
    const [stdout, stderr, result] = await Promise.all([capture(child.stdout), capture(child.stderr), completed]);
    const stdoutRef = await this.#artifactStore.put(stdout.text);
    const stderrRef = await this.#artifactStore.put(stderr.text);
    return {
      script,
      packageManager: manager,
      exitCode: result.code,
      signal: result.signal,
      durationMs: Math.max(0, Math.round(performance.now() - started)),
      stdout: { ...stdoutRef, truncated: stdout.truncated || stdoutRef.truncated },
      stderr: { ...stderrRef, truncated: stderr.truncated || stderrRef.truncated },
      passed: result.code === 0,
    };
  }
}

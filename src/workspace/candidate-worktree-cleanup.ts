import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  CandidateIndex,
  CandidatePairManifest,
  CandidateWorktree,
} from "./candidate-worktree-format.ts";
import { WorktreeManagerError } from "./format.ts";
import {
  git,
  gitOutput,
} from "./worktree-manager.ts";

export type CleanupDiagnosticKind =
  | "active"
  | "dirty"
  | "lease-valid"
  | "not-loser"
  | "pinned"
  | "unregistered"
  | "winner"
  | "cleanup-failed";
export type CleanupDiagnostic = Readonly<{
  requestId: string;
  candidateIndex: CandidateIndex;
  kind: CleanupDiagnosticKind;
}>;
export type CleanupResult = Readonly<{
  removed: readonly Readonly<{ requestId: string; candidateIndex: CandidateIndex }>[];
  diagnostics: readonly CleanupDiagnostic[];
  releaseOwnerIds: readonly string[];
}>;
export type CandidateCleanupContext = Readonly<{
  manifestsRoot: string;
  worktreesRoot: string;
  now: () => number;
  requiredPair: (requestId: string) => Promise<CandidatePairManifest>;
  replaceCandidate: (
    pair: CandidatePairManifest,
    candidateIndex: CandidateIndex,
    candidate: CandidateWorktree,
  ) => Promise<CandidatePairManifest>;
}>;

type RemovalDecision = "remove" | CleanupDiagnosticKind;

export async function cleanupExpiredCandidates(context: CandidateCleanupContext): Promise<CleanupResult> {
  const removed: Array<{ readonly requestId: string; readonly candidateIndex: CandidateIndex }> = [];
  const diagnostics: CleanupDiagnostic[] = [];
  const releaseOwnerIds: string[] = [];
  const names = (await readdir(context.manifestsRoot)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    let pair = await context.requiredPair(name.slice(0, -5));
    for (const candidate of pair.candidates) {
      if (candidate.removedAtMs !== null) continue;
      const decision = removalDecision(context, pair, candidate);
      if (decision !== "remove") {
        diagnostics.push({ requestId: pair.requestId, candidateIndex: candidate.candidateIndex, kind: decision });
        continue;
      }
      try {
        await removeCandidateWorkspace(pair.sourceRepositoryRoot, candidate);
        pair = await context.replaceCandidate(pair, candidate.candidateIndex, {
          ...candidate,
          removedAtMs: context.now(),
        });
        removed.push({ requestId: pair.requestId, candidateIndex: candidate.candidateIndex });
        releaseOwnerIds.push(pair.retentionOwnerIds[candidate.candidateIndex]);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        pair = await context.replaceCandidate(pair, candidate.candidateIndex, {
          ...candidate,
          status: { protocolVersion: 1, kind: "cleanup_failed" },
        });
        diagnostics.push({ requestId: pair.requestId, candidateIndex: candidate.candidateIndex, kind: "cleanup-failed" });
      }
    }
  }
  return { removed, diagnostics, releaseOwnerIds };
}

export function isCandidateRegistered(sourceRepositoryRoot: string, candidate: CandidateWorktree): boolean {
  if (candidate.registration === "linked-worktree") {
    return gitOutput(sourceRepositoryRoot, ["worktree", "list", "--porcelain", "-z"], "unable to list Git worktrees")
      .split("\0").includes(`worktree ${candidate.workspacePath}`);
  }
  return git(candidate.workspacePath, ["rev-parse", "--show-toplevel"]).stdout.trim() === candidate.workspacePath;
}

function removalDecision(
  context: CandidateCleanupContext,
  pair: CandidatePairManifest,
  candidate: CandidateWorktree,
): RemovalDecision {
  switch (candidate.status.kind) {
    case "active": return "active";
    case "loser":
      break;
    case "winner": return "winner";
    case "completed":
    case "abandoned":
    case "cleanup_failed": return "not-loser";
    default:
      throw new WorktreeManagerError("invalid_manifest", `unsupported candidate status: ${String(candidate.status)}`);
  }
  if (candidate.pinned) return "pinned";
  if (candidate.lease.expiresAtMs > context.now()) return "lease-valid";
  if (candidate.workspacePath !== join(context.worktreesRoot, `${pair.requestId}-${candidate.candidateIndex}`)) return "unregistered";
  if (!isCandidateRegistered(pair.sourceRepositoryRoot, candidate)) return "unregistered";
  if (gitOutput(candidate.workspacePath, ["status", "--porcelain=v1", "--untracked-files=all"], "unable to inspect candidate status").length > 0) return "dirty";
  return "remove";
}

async function removeCandidateWorkspace(sourceRepositoryRoot: string, candidate: CandidateWorktree): Promise<void> {
  if (candidate.registration === "linked-worktree") {
    gitOutput(sourceRepositoryRoot, ["worktree", "remove", candidate.workspacePath], "unable to remove candidate worktree");
    return;
  }
  await rm(candidate.workspacePath, { recursive: true });
}

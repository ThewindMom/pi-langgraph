import { resolve } from "node:path";
import type { ResolvedCheckpointLink } from "../bridge/session-checkpoint-bridge.ts";
import {
  checkpointReplayMetadata,
  repositoryCheckpointIdentity,
} from "../persistence/checkpoint-thread-codec.ts";
import type { FileCheckpointSaver } from "../persistence/file-checkpoint-saver.ts";
import { ReplayCompatibilityError } from "../workflow/replay-compatibility.ts";
import { ReplayResumeRejectedError } from "./replay-context.ts";

export type ActiveResumeTargetInput = Readonly<{
  activeLink: ResolvedCheckpointLink | undefined;
  checkpoints: FileCheckpointSaver;
  threadId: string;
  cwd: string;
  forkWorkspacePath: string | undefined;
}>;

export async function assertActiveResumeTarget(
  input: ActiveResumeTargetInput,
): Promise<string | undefined> {
  const active = input.activeLink;
  if (active === undefined) return undefined;
  if (active.link.threadId !== input.threadId) {
    throw new ReplayResumeRejectedError("active-link-mismatch");
  }
  const [selected, latest] = await Promise.all([
    input.checkpoints.getTuple({
      configurable: {
        thread_id: input.threadId,
        checkpoint_id: active.link.checkpointId,
      },
    }),
    input.checkpoints.getTuple({
      configurable: { thread_id: input.threadId },
    }),
  ]);
  if (selected === undefined || selected.checkpoint.id !== active.link.checkpointId) {
    throw new ReplayResumeRejectedError("checkpoint-lineage-mismatch");
  }
  if (latest === undefined || latest.checkpoint.id !== selected.checkpoint.id) {
    throw new ReplayResumeRejectedError("active-checkpoint-requires-fork");
  }
  if (!worktreeMatches(input)) {
    throw new ReplayResumeRejectedError("active-worktree-mismatch");
  }
  let replay;
  try {
    replay = checkpointReplayMetadata(selected.metadata);
  } catch (error) {
    if (error instanceof ReplayCompatibilityError) {
      throw new ReplayResumeRejectedError("invalid-replay-metadata");
    }
    throw error;
  }
  const repository = repositoryCheckpointIdentity(selected.metadata);
  const binding = replay?.replayBinding;
  if (
    replay?.replayFingerprint !== active.link.replayFingerprint ||
    !replay?.semanticLabels.includes(active.link.label) ||
    binding === undefined ||
    binding.checkpoint.threadId !== input.threadId ||
    binding.checkpoint.checkpointId !== selected.checkpoint.id ||
    binding.checkpoint.lineage.at(-1) !== selected.checkpoint.id ||
    binding.effectLedgerDigest !== active.link.effectLedgerDigest ||
    repository?.snapshotId !== active.link.repositorySnapshot.snapshotId ||
    repository.head !== active.link.repositorySnapshot.baselineHead
  ) {
    throw new ReplayResumeRejectedError("checkpoint-lineage-mismatch");
  }
  return selected.checkpoint.id;
}

function worktreeMatches(input: ActiveResumeTargetInput): boolean {
  const managedPath = input.activeLink?.link.managedWorktree?.path;
  if (input.forkWorkspacePath !== undefined) {
    return managedPath !== undefined &&
      resolve(managedPath) === resolve(input.forkWorkspacePath);
  }
  return managedPath === undefined || resolve(managedPath) === resolve(input.cwd);
}

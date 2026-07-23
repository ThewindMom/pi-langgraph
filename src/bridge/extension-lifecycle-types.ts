import type {
  SessionBeforeForkEvent,
  SessionBeforeTreeEvent,
  SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import type { PiLifecycleContext } from "../types.ts";
import type { WorkflowEvent } from "../workflow/stream-events.ts";
import type { ResolvedCheckpointLink } from "./session-checkpoint-bridge.ts";
import type { BridgeIntentRecord } from "./store.ts";
import type {
  ManagedWorktreeRefV1,
  SemanticCheckpointLabel,
  SessionCheckpointLinkV1,
} from "./types.ts";

export type LifecycleDecision =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export type ForkPreparation =
  | Readonly<{
    kind: "accepted";
    worktree: ManagedWorktreeRefV1;
    destinationLink: SessionCheckpointLinkV1;
  }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export type LifecycleFailure = Readonly<{
  event:
    | "workflow_checkpoint"
    | "workflow_completed"
    | "session_start"
    | "session_before_tree"
    | "session_tree"
    | "session_before_fork";
  reason: string;
  error?: Error;
}>;

export interface ExtensionLifecycleObserver {
  resolveCheckpointLink?(
    event: Extract<WorkflowEvent, Readonly<{ kind: "checkpoint" }>>,
    label: SemanticCheckpointLabel,
    context: PiLifecycleContext,
  ): Promise<SessionCheckpointLinkV1 | undefined>;
  resolveCompletedLink?(
    details: unknown,
    context: PiLifecycleContext,
  ): Promise<SessionCheckpointLinkV1 | undefined>;
  prepareTree?(
    resolved: ResolvedCheckpointLink,
    event: SessionBeforeTreeEvent,
    context: PiLifecycleContext,
  ): Promise<LifecycleDecision>;
  treeSelected?(
    intent: BridgeIntentRecord,
    event: SessionTreeEvent,
    context: PiLifecycleContext,
  ): Promise<void>;
  prepareFork?(
    resolved: ResolvedCheckpointLink,
    event: SessionBeforeForkEvent,
    context: PiLifecycleContext,
  ): Promise<ForkPreparation>;
  bindFork?(
    intent: BridgeIntentRecord,
    destinationSessionId: string,
    context: PiLifecycleContext,
  ): Promise<void>;
  failure?(failure: LifecycleFailure, context: PiLifecycleContext): void;
}

import type { SemanticCheckpointLabel } from "./types.ts";

export class LifecycleBridgeError extends Error {
  readonly name = "LifecycleBridgeError";

  constructor(readonly value: unknown) {
    super(`Pi lifecycle bridge failed with a non-error value: ${String(value)}`);
  }
}

export class LifecycleLinkMismatchError extends Error {
  readonly name = "LifecycleLinkMismatchError";

  constructor(
    readonly checkpointId: string,
    readonly label: SemanticCheckpointLabel,
  ) {
    super(`workflow checkpoint link does not match ${checkpointId}:${label}`);
  }
}

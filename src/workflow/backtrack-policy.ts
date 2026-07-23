export interface BacktrackPolicyInput {
  readonly failedChecks: Readonly<{ readonly test: number; readonly typecheck: number; readonly lint: number; readonly build: number }>;
  readonly repeatedFailureSignature: boolean;
  readonly noProgress: boolean;
  readonly regressions: number;
  readonly diagnosis: Readonly<{ readonly planInvalidating: boolean }>;
  readonly iteration: Readonly<{ readonly current: number; readonly budget: number }>;
  readonly effects: Readonly<{ readonly safe: boolean }>;
  readonly replay: Readonly<{ readonly compatible: boolean }>;
  readonly risk: Readonly<{ readonly ambiguous: boolean }>;
}

export type BacktrackAction = "retry-current-repair" | "compare-two-candidates" | "escalate-manual";

export interface BacktrackPolicyDecision {
  readonly action: BacktrackAction;
  readonly candidateCount: 0 | 2;
  readonly reason: "recoverable-check-failure" | "repeated-no-progress" | "unsafe-or-incompatible" | "budget-exhausted" | "plan-invalidated" | "ambiguous-risk";
}

export function classifyBacktrackTrigger(input: BacktrackPolicyInput): BacktrackPolicyDecision {
  if (input.diagnosis.planInvalidating) return decision("escalate-manual", 0, "plan-invalidated");
  if (!input.effects.safe || !input.replay.compatible) return decision("escalate-manual", 0, "unsafe-or-incompatible");
  if (input.risk.ambiguous) return decision("escalate-manual", 0, "ambiguous-risk");
  if (input.repeatedFailureSignature || input.noProgress || input.regressions > 0) return decision("compare-two-candidates", 2, "repeated-no-progress");
  if (input.iteration.current >= input.iteration.budget) return decision("escalate-manual", 0, "budget-exhausted");
  return decision("retry-current-repair", 0, "recoverable-check-failure");
}

export const decideBacktrackPolicy = classifyBacktrackTrigger;

function decision(action: BacktrackAction, candidateCount: 0 | 2, reason: BacktrackPolicyDecision["reason"]): BacktrackPolicyDecision {
  return { action, candidateCount, reason };
}

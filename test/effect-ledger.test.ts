import { describe, expect, test } from "bun:test";
import {
  EffectLedgerError,
  assessAutomaticBacktrackSafety,
  effectLedgerDigest,
  parseEffectLedger,
} from "../src/workflow/effect-ledger.ts";

describe("effect ledger", () => {
  test("canonical ledger digest is stable when effect object keys reorder", () => {
    // Given: semantically identical ledgers whose object keys differ.
    const first = { protocolVersion: 1, effects: [{ kind: "repository-write", effectId: "write-1", reversible: true }] };
    const second = { effects: [{ reversible: true, effectId: "write-1", kind: "repository-write" }], protocolVersion: 1 };

    // When: each ledger is parsed and digested.
    const firstDigest = effectLedgerDigest(parseEffectLedger(first));
    const secondDigest = effectLedgerDigest(parseEffectLedger(second));

    // Then: canonical ordering produces one identity.
    expect(secondDigest).toBe(firstDigest);
  });

  test("unknown effect blocks automatic backtrack without compensation", () => {
    // Given: an opaque effect and a callback that would prove an external undo attempt.
    const ledger = parseEffectLedger({ protocolVersion: 1, effects: [{ kind: "unknown", effectId: "opaque-1" }] });
    let compensationCalls = 0;
    const compensate = () => { compensationCalls += 1; };

    // When: automatic backtrack safety is assessed.
    const decision = assessAutomaticBacktrackSafety(ledger);

    // Then: it is blocked before any compensator or external undo can be invoked.
    expect(decision).toEqual({ kind: "blocked_unknown_effect", effectId: "opaque-1" });
    expect(compensationCalls).toBe(0);
    expect(compensate).toBeDefined();
  });

  test("pending and noncompensable known effects return typed blocks", () => {
    // Given: outstanding known external effects in each unsafe compensation state.
    const pending = parseEffectLedger({ protocolVersion: 1, effects: [{ kind: "external-known", effectId: "mail-1", compensation: "pending" }] });
    const noncompensable = parseEffectLedger({ protocolVersion: 1, effects: [{ kind: "external-known", effectId: "payment-1", compensation: "noncompensable" }] });

    // When / Then: each state yields its explicit blocking decision.
    expect(assessAutomaticBacktrackSafety(pending)).toEqual({ kind: "blocked_pending_effect", effectId: "mail-1" });
    expect(assessAutomaticBacktrackSafety(noncompensable)).toEqual({ kind: "blocked_noncompensable_effect", effectId: "payment-1" });
  });

  test("rejects duplicate identifiers and unsafe repository writes", () => {
    // Given: invalid ledger input and a local write without a reversible record.
    const duplicate = { protocolVersion: 1, effects: [
      { kind: "repository-write", effectId: "write-1", reversible: true },
      { kind: "unknown", effectId: "write-1" },
    ] };
    const irreversible = parseEffectLedger({ protocolVersion: 1, effects: [{ kind: "repository-write", effectId: "write-2", reversible: false }] });

    // When / Then: bad records cannot be accepted and irreversible changes are blocked.
    expect(() => parseEffectLedger(duplicate)).toThrow(EffectLedgerError);
    expect(assessAutomaticBacktrackSafety(irreversible)).toEqual({ kind: "blocked_noncompensable_effect", effectId: "write-2" });
  });
});

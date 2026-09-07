import { ADMISSION_DEFAULTS } from '@noodle-borg/admission-limits';
import { describe, expect, it } from 'vitest';
import {
  billedOutputTokens,
  MANAGED_SPEND_UNIT_TOKENS,
  managedSpendAllowanceForTurns,
  managedSpendDrift,
  managedSpendPolicy,
  managedSpendRung,
  managedSpendUnitWeight,
  remainingTurnTokens,
} from '../src/managed-spend.js';

/**
 * The ladder is a pure function so its shape can be argued about without a provider, a counter, or a
 * tenant. Every property below is one the runtime depends on being true.
 */
describe('the managed spend ladder', () => {
  it('climbs monotonically as the allowance is used', () => {
    const rungs = [0, 0.3, 0.6, 0.8, 0.95, 1, 2].map((share) =>
      managedSpendRung(Math.round(share * 1_000), 1_000),
    );
    expect(rungs).toEqual([0, 0, 1, 2, 3, 4, 4]);
    for (const [index, rung] of rungs.entries()) {
      expect(rung).toBeGreaterThanOrEqual(rungs[index - 1] ?? 0);
    }
  });

  it('treats a missing or nonsensical allowance as unbudgeted rather than exhausted', () => {
    // Failing an allowance closed would take a surface dark over a typo. The per-surface daily cap
    // still bounds the damage, so the safe direction here is "no ladder", not "rung 4".
    expect(managedSpendRung(500, 0)).toBe(0);
    expect(managedSpendRung(500, Number.NaN)).toBe(0);
    expect(managedSpendRung(500, -1)).toBe(0);
  });

  it('charges less per turn the further down the ladder a tenant is', () => {
    const weights = [0, 1, 2, 3].map((rung) => managedSpendUnitWeight(rung));
    for (const [index, weight] of weights.entries()) {
      expect(weight).toBeGreaterThanOrEqual(1);
      if (index > 0) expect(weight).toBeLessThanOrEqual(weights[index - 1] as number);
    }
  });

  /**
   * The honesty invariant. A weight is a claim about a turn's worst case, and it is only true if the
   * rung's own request policy enforces it — otherwise the ledger is fiction and the cap is decorative.
   */
  it('never charges less than the worst case its own policy permits', () => {
    for (const rung of [0, 1, 2, 3]) {
      const policy = managedSpendPolicy(rung).requestPolicy;
      const promptTokens = ((policy.maxModelStepsPerTurn ?? 1) * (policy.maxRequestBytes ?? 0)) / 4;
      const worstCase = promptTokens + 8 * (policy.maxTokensPerTurn ?? 0);
      expect(managedSpendUnitWeight(rung) * MANAGED_SPEND_UNIT_TOKENS).toBeGreaterThanOrEqual(
        worstCase,
      );
    }
  });

  it('denominates an allowance in ordinary turns, and stretches it as the ladder tightens', () => {
    const allowance = managedSpendAllowanceForTurns(5_000);
    // A day of undegraded turns lands exactly on the cap, so the configured number means what it says.
    expect(Math.floor(allowance / managedSpendUnitWeight(0))).toBe(5_000);
    // The same allowance buys materially more turns once the ladder has tightened them.
    expect(allowance / managedSpendUnitWeight(3)).toBeGreaterThan(5_000 * 2);
    expect(managedSpendAllowanceForTurns(0)).toBe(0);
    expect(managedSpendAllowanceForTurns(Number.NaN)).toBe(0);
  });

  it('degrades by tightening the envelope, never by raising it', () => {
    for (const rung of [0, 1, 2, 3, 4]) {
      const { admission } = managedSpendPolicy(rung);
      expect(admission.defaults.turnsPerSession).toBeLessThanOrEqual(
        ADMISSION_DEFAULTS.turnsPerSession,
      );
      expect(admission.ceiling.turnsPerDay).toBeLessThanOrEqual(admission.defaults.turnsPerDay);
    }
  });

  /**
   * Rung 4 must be the existing kill switch and nothing new. Returning no binding at all would make
   * the agent loop emit `managed_model_unavailable` mid-stream; zero ceilings refuse calmly at
   * admission, before any model call, with the code every shipped widget already treats as final.
   */
  it('closes the surface at rung 4 with both existing ceilings, not a new failure', () => {
    const { admission } = managedSpendPolicy(4);
    expect(admission.ceiling.turnsPerDay).toBe(0);
    expect(admission.ceiling.mintsPerDay).toBe(0);
  });

  /**
   * Telemetry calibrates the ledger; it never gates. A breach here is not "this tenant spent a lot",
   * it is "a rung's request policy is not bounding what the weight claims" — an enforcer bug.
   */
  it('flags a turn that cost more than its most permissive rung allows', () => {
    const permitted = managedSpendUnitWeight(0) * MANAGED_SPEND_UNIT_TOKENS;

    expect(
      managedSpendDrift({ deliveredTurns: 100, promptTokens: 400_000, completionTokens: 20_000 }),
    ).toMatchObject({ exceeded: false });
    expect(
      managedSpendDrift({
        deliveredTurns: 1,
        promptTokens: permitted * 2,
        completionTokens: 0,
      }).exceeded,
    ).toBe(true);
    // No turns is no evidence, not a breach.
    expect(
      managedSpendDrift({ deliveredTurns: 0, promptTokens: 1e9, completionTokens: 1e9 }),
    ).toMatchObject({
      exceeded: false,
      observedPerTurn: 0,
    });
  });

  /**
   * Reasoning tokens are output. Every provider we serve bills "thinking" at the output rate, and
   * the production surface measured them at 5.4x the visible completion — so a drift check that
   * counts only `completionTokens` under-reads the very cost it exists to police, and the breach it
   * would miss is exactly the one that matters: a rung whose policy does not bound what it claims.
   */
  it('counts reasoning tokens as the output they are billed as', () => {
    const withoutReasoning = managedSpendDrift({
      deliveredTurns: 10,
      promptTokens: 1_000,
      completionTokens: 100,
    });
    const withReasoning = managedSpendDrift({
      deliveredTurns: 10,
      promptTokens: 1_000,
      completionTokens: 100,
      reasoningTokens: 900,
    });
    // A thousand output tokens weighted the same whichever half of the split they arrive in.
    expect(withReasoning.observedPerTurn).toBe(
      managedSpendDrift({ deliveredTurns: 10, promptTokens: 1_000, completionTokens: 1_000 })
        .observedPerTurn,
    );
    expect(withReasoning.observedPerTurn).toBeGreaterThan(withoutReasoning.observedPerTurn);
    // Absent reasoning must read exactly as it did before, or every non-reasoning model moves.
    expect(withoutReasoning.observedPerTurn).toBe(
      managedSpendDrift({
        deliveredTurns: 10,
        promptTokens: 1_000,
        completionTokens: 100,
        reasoningTokens: 0,
      }).observedPerTurn,
    );
  });

  it('catches an enforcer that bounds completion while reasoning runs away', () => {
    const permitted = managedSpendUnitWeight(0) * MANAGED_SPEND_UNIT_TOKENS;
    // The shape of the hole this fix closes: visible output well inside the cap, thinking far past
    // it. Counting completion alone reports a comfortable turn.
    const observed = {
      deliveredTurns: 1,
      promptTokens: 0,
      completionTokens: 10,
      reasoningTokens: permitted,
    };
    expect(managedSpendDrift(observed).exceeded).toBe(true);
  });
});

describe('billed output tokens', () => {
  it('adds reasoning to completion, and treats an absent count as zero', () => {
    expect(billedOutputTokens({ completionTokens: 100, reasoningTokens: 900 })).toBe(1_000);
    expect(billedOutputTokens({ completionTokens: 100 })).toBe(100);
  });

  it('spends a turn budget on billed output, and assumes the worst when usage is missing', () => {
    expect(remainingTurnTokens(1_000, { completionTokens: 50, reasoningTokens: 200 }, 500)).toBe(
      750,
    );
    // No usage block means the step is assumed to have spent its whole allowance. Reading it as
    // zero would let a provider that omits usage run the loop to its step ceiling for free.
    expect(remainingTurnTokens(1_000, undefined, 500)).toBe(500);
    // The floor is zero, never negative: the loop tests `<= 0` and a negative would still be spent.
    expect(remainingTurnTokens(100, { completionTokens: 0, reasoningTokens: 9_000 }, 500)).toBe(0);
  });
});

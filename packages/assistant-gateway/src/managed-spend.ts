import type { AdmissionEnvelope } from '@noodle-borg/admission-limits/portable';
import type { AssistantModelRequestPolicy } from './model-request.js';
import type { SurfaceBudgetBounds } from './surface-budget.js';

/**
 * Cost breakers for the sponsored managed-assistant beta (ADR 0213 amendment §3).
 *
 * Noodle pays for `noodle-managed` inference and charges nothing for it, so aggregate spend is a
 * platform expense with no customer-side limit standing behind it. Per-surface daily caps bound one
 * surface; they do not bound how many surfaces enrol. This is the missing ceiling, expressed as a
 * ladder rather than a switch: a tenant approaching its allowance gets shorter answers before it gets
 * a closed door, and the door itself is the kill switch that already exists.
 *
 * Two things make it small. Every rung is expressed through `SurfaceBudgetBounds` and
 * `AssistantModelRequestPolicy`, which the resolver already returns and admission already reads live
 * per turn — so degradation applies immediately and reverses on its own when the UTC day rolls, with
 * no unwind path to write. And the unit is one delivered bounded turn, which is the billable unit ADR
 * 0213 §12 already defines.
 */

/**
 * Billable tokens per charged unit. Prompt and completion are counted together and completion is
 * weighted, because output costs several times input on every provider we have measured.
 */
export const MANAGED_SPEND_UNIT_TOKENS = 4_000;
const OUTPUT_WEIGHT = 8;
const BYTES_PER_TOKEN = 4;

export interface ManagedSpendPolicy {
  readonly requestPolicy: AssistantModelRequestPolicy;
  readonly admission: SurfaceBudgetBounds;
}

/**
 * The rungs, tightest-claim-first.
 *
 * Rung 0 is not "today's policy": a weight is only honest if the rung's own policy enforces it, and
 * an unbounded prompt makes the worst case forty times the typical turn. Bounding the request keeps
 * the ledger true. These numbers are the starting point and are expected to move once measured P99
 * prompt sizes are read off the live surface — that measurement is a gate on raising the ceilings,
 * not on shipping the breaker.
 */
const RUNGS: readonly ManagedSpendPolicy[] = [
  {
    requestPolicy: {
      maxRequestBytes: 32 * 1_024,
      maxCompletionTokens: 1_500,
      maxTokensPerTurn: 3_000,
      maxModelStepsPerTurn: 6,
      maxToolCallsPerTurn: 8,
    },
    admission: {
      defaults: { turnsPerSession: 40, turnsPerDay: 20_000, mintsPerDay: 5_000 },
      ceiling: { turnsPerDay: 20_000, mintsPerDay: 5_000 },
    },
  },
  {
    // Shorter answers. Nothing is announced: telling a stranger on a customer's marketing site that
    // it is on a reduced tier harms the customer and helps no one, and a shorter answer explains
    // itself.
    requestPolicy: {
      maxRequestBytes: 24 * 1_024,
      maxCompletionTokens: 900,
      maxTokensPerTurn: 1_800,
      maxModelStepsPerTurn: 4,
      maxToolCallsPerTurn: 6,
    },
    admission: {
      defaults: { turnsPerSession: 40, turnsPerDay: 20_000, mintsPerDay: 5_000 },
      ceiling: { turnsPerDay: 20_000, mintsPerDay: 5_000 },
    },
  },
  {
    // Shorter conversations. This does not lower a turn's worst case — `maxRequestBytes` already caps
    // that — it lowers the typical prompt by cutting history growth, which stretches the remaining
    // allowance without shortening any individual answer. The visitor meets
    // `session_turn_budget_exhausted`, which the widget already renders as its existing "new
    // conversation" affordance.
    requestPolicy: {
      maxRequestBytes: 16 * 1_024,
      maxCompletionTokens: 700,
      maxTokensPerTurn: 1_400,
      maxModelStepsPerTurn: 3,
      maxToolCallsPerTurn: 4,
    },
    admission: {
      defaults: { turnsPerSession: 8, turnsPerDay: 20_000, mintsPerDay: 5_000 },
      ceiling: { turnsPerDay: 20_000, mintsPerDay: 5_000 },
    },
  },
  {
    // No tools. `projectAssistantGuide` projects the per-turn tool set, so the guide never promises a
    // tool that is not offered; the assistant simply answers from knowledge and its own words.
    requestPolicy: {
      maxRequestBytes: 12 * 1_024,
      maxCompletionTokens: 400,
      maxTokensPerTurn: 800,
      maxModelStepsPerTurn: 1,
      maxToolCallsPerTurn: 0,
    },
    admission: {
      defaults: { turnsPerSession: 8, turnsPerDay: 20_000, mintsPerDay: 5_000 },
      ceiling: { turnsPerDay: 20_000, mintsPerDay: 5_000 },
    },
  },
  {
    // At cap. Deliberately the *existing* kill switch and not a new failure mode: zero ceilings refuse
    // at admission with `daily_turn_budget_exhausted`, a code every published widget already treats as
    // final. A new code would be read as retryable by every widget predating it, and they would hammer
    // the endpoint this cap exists to protect.
    requestPolicy: {
      maxRequestBytes: 12 * 1_024,
      maxCompletionTokens: 400,
      maxTokensPerTurn: 800,
      maxModelStepsPerTurn: 1,
      maxToolCallsPerTurn: 0,
    },
    admission: {
      defaults: { turnsPerSession: 8, turnsPerDay: 0, mintsPerDay: 0 },
      ceiling: { turnsPerDay: 0, mintsPerDay: 0 },
    },
  },
];

/** Fractions of the allowance at which each rung begins. */
const THRESHOLDS: readonly number[] = [0.6, 0.8, 0.95, 1];

/**
 * Which rung a tenant is on.
 *
 * An absent or nonsensical allowance means "unbudgeted", never "exhausted". Failing closed on a typo
 * would take a customer's surface dark for a configuration mistake, and the per-surface daily cap
 * still bounds what that costs.
 */
export function managedSpendRung(unitsUsed: number, allowance: number): number {
  if (!Number.isFinite(allowance) || allowance <= 0) return 0;
  const share = Math.max(0, unitsUsed) / allowance;
  return THRESHOLDS.filter((threshold) => share >= threshold).length;
}

export function managedSpendPolicy(rung: number): ManagedSpendPolicy {
  return RUNGS[Math.min(Math.max(Math.trunc(rung), 0), RUNGS.length - 1)] as ManagedSpendPolicy;
}

/**
 * Units one turn costs at this rung: its worst case under the rung's own policy, in whole units.
 *
 * Prompt-inclusive on purpose. `maxCompletionTokens` says nothing about how large a prompt the agent
 * loop may resend on each step, and the prompt is where an unbounded turn actually spends.
 */
export function managedSpendUnitWeight(rung: number): number {
  const { requestPolicy } = managedSpendPolicy(rung);
  const prompt =
    ((requestPolicy.maxModelStepsPerTurn ?? 1) * (requestPolicy.maxRequestBytes ?? 0)) /
    BYTES_PER_TOKEN;
  const output = OUTPUT_WEIGHT * (requestPolicy.maxTokensPerTurn ?? 0);
  return Math.max(1, Math.ceil((prompt + output) / MANAGED_SPEND_UNIT_TOKENS));
}

/**
 * The unit ledger for a day's worth of ordinary turns.
 *
 * Units are worst-case, so a turn is charged what its rung's policy *permits* rather than what it
 * happened to use. That is deliberate — the alternative under-charges exactly the adversary the cap
 * exists for — but it means the number is only meaningful denominated in turns. An allowance is
 * therefore configured as "this many sponsored turns a day" and converted here, which is also the
 * form the operator surface reports.
 *
 * The conservatism is uniform within a rung, so it does not distort when the ladder trips; across
 * rungs it is the intended effect, since a degraded turn genuinely costs less and the same allowance
 * stretches further.
 */
export function managedSpendAllowanceForTurns(turnsPerDay: number): number {
  if (!Number.isFinite(turnsPerDay) || turnsPerDay <= 0) return 0;
  return Math.ceil(turnsPerDay) * managedSpendUnitWeight(0);
}

/**
 * Output tokens a provider bills for one completion.
 *
 * Reasoning tokens are output. Every provider we serve bills "thinking" at the output rate, and the
 * production surface measured them at 5.4x the visible completion — so counting `completionTokens`
 * alone enforces a per-turn ceiling on roughly a sixth of what the turn costs, and reports the same
 * shortfall to the drift check whose entire job is noticing a rung that does not bound what it
 * claims. One definition, used by the enforcer and by the telemetry that audits the enforcer,
 * because two definitions is how the blind spot got here.
 *
 * An absent count means the provider reported none, never "unknown": a model with no reasoning
 * phase omits the field, and must read exactly as it did before.
 */
export function billedOutputTokens(usage: {
  readonly completionTokens: number;
  readonly reasoningTokens?: number;
}): number {
  return usage.completionTokens + (usage.reasoningTokens ?? 0);
}

/**
 * What remains of a turn's token budget after one completion.
 *
 * The fallback when a provider reports no usage at all is the whole request limit rather than zero:
 * a step whose cost is unknown must be assumed to have spent everything it was allowed, or a
 * provider that omits the block would make the turn unbounded.
 */
export function remainingTurnTokens(
  remaining: number,
  usage: { readonly completionTokens: number; readonly reasoningTokens?: number } | undefined,
  requestLimit: number,
): number {
  return Math.max(0, remaining - (usage === undefined ? requestLimit : billedOutputTokens(usage)));
}

/**
 * Is the ledger telling the truth?
 *
 * A unit weight is a claim about what a turn's own rung permits. If the rung's `requestPolicy` does
 * not actually bound what it says, the claim is fiction and the whole cap is decorative — and the
 * failure is silent, because a cheap-looking ledger is exactly what an unbounded turn produces.
 *
 * So telemetry checks the counter rather than replacing it. Observed billable tokens per delivered
 * turn must stay under what rung 0 permits, since rung 0 is the most permissive rung any turn could
 * have run at. Exceeding it is not a budgeting question; it means an enforcer is not enforcing.
 */
export function managedSpendDrift(observed: {
  readonly deliveredTurns: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly reasoningTokens?: number;
}): {
  readonly observedPerTurn: number;
  readonly permittedPerTurn: number;
  readonly exceeded: boolean;
} {
  const permittedPerTurn = managedSpendUnitWeight(0) * MANAGED_SPEND_UNIT_TOKENS;
  if (observed.deliveredTurns <= 0) {
    return { observedPerTurn: 0, permittedPerTurn, exceeded: false };
  }
  const billable = observed.promptTokens + OUTPUT_WEIGHT * billedOutputTokens(observed);
  const observedPerTurn = Math.round(billable / observed.deliveredTurns);
  return { observedPerTurn, permittedPerTurn, exceeded: observedPerTurn > permittedPerTurn };
}

/** Convenience for readers that only care whether a tenant is being held back at all. */
export function isManagedSpendDegraded(envelope: Pick<AdmissionEnvelope, 'turnsPerDay'>): boolean {
  return envelope.turnsPerDay === 0;
}

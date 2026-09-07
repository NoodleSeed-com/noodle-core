import { type AdmissionEnvelope, clamp } from '@noodle-borg/admission-limits/portable';
import type { PublicEmbedRecord } from './embed-store.js';

/** Hosted/operator entitlement layered between structural maxima and per-surface overrides. */
export interface SurfaceBudgetBounds {
  readonly defaults: Pick<AdmissionEnvelope, 'turnsPerSession' | 'turnsPerDay' | 'mintsPerDay'>;
  readonly ceiling: Pick<AdmissionEnvelope, 'turnsPerDay' | 'mintsPerDay'>;
  /**
   * Platform spend accounting for this turn, present only when someone other than the customer is
   * paying. Absent means customer-funded, and nothing is charged.
   *
   * `units` is what this turn costs at the tenant's current rung and `allowance` is its ceiling for
   * the day; the ladder that produces both lives in `managed-spend.ts`. The ceilings above remain the
   * primary mechanism — this counter is the exact backstop for the window in which a cached rung
   * read still says "plenty left".
   */
  readonly spend?: {
    readonly key: string;
    readonly units: number;
    readonly allowance: number;
  };
}

/**
 * One surface's daily budget, resolved from the operator's override and the deployment's defaults.
 *
 * Per surface rather than per service, because the question a customer actually asks is "does capping
 * my marketing bot throttle my in-app assistant" — and the answer has to be an obvious no. The override
 * lives on the embed row, which `ensure` never overwrites, so a redeploy cannot silently reset a kill
 * switch someone reached for.
 *
 * Routed through `clamp` rather than used directly: the structural maximum is not negotiable by an
 * operator any more than by app code, so an over-eager `--turns-per-day 999999999` degrades to the
 * ceiling instead of becoming the ceiling. Zero survives clamping and is the kill switch.
 */
export function surfaceEnvelope(
  base: AdmissionEnvelope,
  embed: Pick<
    PublicEmbedRecord,
    | 'turnsPerDay'
    | 'mintsPerDay'
    | 'mintsPerAddressHour'
    | 'turnsPerAddressHour'
    | 'bridgeToolCallsPerSession'
    | 'bridgeToolCallsPerDay'
  >,
  bounds?: SurfaceBudgetBounds,
): AdmissionEnvelope {
  const effectiveBase = bounds === undefined ? base : clamp({ ...base, ...bounds.defaults });
  const requested = clamp({
    ...effectiveBase,
    ...(embed.turnsPerDay !== undefined ? { turnsPerDay: embed.turnsPerDay } : {}),
    ...(embed.mintsPerDay !== undefined ? { mintsPerDay: embed.mintsPerDay } : {}),
    // The per-address bounds carry no hosted ceiling, because they govern abuse rather than spend —
    // so the deployed default is what caps them, and an operator may only lower it. A surface that
    // could raise its own abuse bound toward the structural maximum would be turning the bound off
    // for everyone behind one address, which is not a budget an operator gets to spend.
    ...(embed.mintsPerAddressHour !== undefined
      ? {
          mintsPerAddressHour: Math.min(
            embed.mintsPerAddressHour,
            effectiveBase.mintsPerAddressHour,
          ),
        }
      : {}),
    ...(embed.turnsPerAddressHour !== undefined
      ? {
          turnsPerAddressHour: Math.min(
            embed.turnsPerAddressHour,
            effectiveBase.turnsPerAddressHour,
          ),
        }
      : {}),
    // The bridge bounds are the operator's to spend in either direction, like the daily caps and
    // unlike the per-address ones: they govern this surface's own agent traffic against its own
    // connectors, not a bound shared with everyone behind one address. `clamp` still holds them
    // under the structural maximum.
    ...(embed.bridgeToolCallsPerSession !== undefined
      ? { bridgeToolCallsPerSession: embed.bridgeToolCallsPerSession }
      : {}),
    ...(embed.bridgeToolCallsPerDay !== undefined
      ? { bridgeToolCallsPerDay: embed.bridgeToolCallsPerDay }
      : {}),
  });
  if (bounds === undefined) return requested;
  return {
    ...requested,
    turnsPerDay: Math.min(requested.turnsPerDay, bounds.ceiling.turnsPerDay),
    mintsPerDay: Math.min(requested.mintsPerDay, bounds.ceiling.mintsPerDay),
  };
}

import type { AdmissionEnvelope } from '@noodle-borg/admission-limits/portable';
import type { PublicEmbedRecord } from './embed-store.js';
import { managedSpendRung, managedSpendUnitWeight } from './managed-spend.js';
import type { PublicSurface } from './public-surface.js';

/**
 * The operator's view of one public surface: what it is, and what it may spend.
 *
 * Origins, capabilities, and surfaceMode come from the *active* deployment rather than the embed
 * row, so what an operator reads here is what a browser will actually be held to at mint time. The
 * row keeps its provisioning-time mode by design — `ensure` never overwrites a live row.
 */
export interface AssistantEmbedOperatorView {
  readonly embedId: string;
  readonly surfaceMode: string;
  readonly origins: readonly string[];
  readonly capabilities: readonly string[];
  readonly turnsPerDay: number;
  readonly mintsPerDay: number;
  /**
   * What a browser agent may spend on this surface through the WebMCP bridge. Reported beside the
   * turn caps because "is my budget about to run out" is the same question, and a bridge call spends
   * neither a turn nor a mint — an operator reading only those two would see a quiet day.
   */
  readonly bridgeCallsPerSession: number;
  readonly bridgeCallsPerDay: number;
  /** True when the caps are the deployment defaults rather than something an operator chose. */
  readonly budgetIsDefault: boolean;
  readonly turnsToday: number;
  readonly mintsToday: number;
  readonly bridgeCallsToday: number;
  readonly createdAt: string;
  /**
   * Present only when Noodle is funding this surface's model. It exists so an operator can tell
   * platform-imposed degradation from a bug in their own app, which is the one thing they cannot
   * work out from the caps above — those look normal right up to the moment the ladder closes them.
   */
  readonly managedSpend?: AssistantManagedSpendView;
}

export interface AssistantManagedSpendView {
  /** `normal`, `approaching`, `near`, `limited`, or `closed`. */
  readonly state: string;
  /**
   * Turns left today at the current rung, not a percentage. The spend consume is all-or-nothing, so
   * a costly turn is refused while a cheap one still passes at the tail of the day — a percentage
   * would look like it stopped early.
   */
  readonly turnsRemaining: number;
  /** One plain sentence about what a visitor experiences right now. */
  readonly visitors: string;
}

const SPEND_STATES: readonly { readonly state: string; readonly visitors: string }[] = [
  { state: 'normal', visitors: 'Full answers, full tools.' },
  { state: 'approaching', visitors: 'Shorter answers. Nothing else changes.' },
  {
    state: 'near',
    visitors: 'Shorter answers, and conversations restart after 8 turns.',
  },
  { state: 'limited', visitors: 'Short answers from knowledge only; tools are paused.' },
  {
    state: 'closed',
    visitors: 'Paused until 00:00 UTC. Connect your own model key to keep serving.',
  },
];

/**
 * Project a tenant's spend into what an operator needs to read.
 *
 * Takes the raw peek rather than a rung so the caller owns only the read: which rung that is, and
 * what a turn costs there, are the ladder's business and stay in one place.
 */
export function assistantManagedSpendView(input: {
  readonly spend: { readonly allowance: number };
  readonly unitsUsed: number;
}): AssistantManagedSpendView {
  const rungAt = managedSpendRung(input.unitsUsed, input.spend.allowance);
  const perTurn = managedSpendUnitWeight(rungAt);
  const remaining = Math.max(0, input.spend.allowance - input.unitsUsed);
  const rung = Math.min(rungAt, SPEND_STATES.length - 1);
  return {
    ...(SPEND_STATES[rung] as { readonly state: string; readonly visitors: string }),
    turnsRemaining: perTurn > 0 ? Math.floor(remaining / perTurn) : 0,
  };
}

/**
 * Project one embed row into that view. Pure on purpose: the caller owns the reads (active
 * deployment, counter peeks) and this owns the shape, so the projection stays testable without a
 * registry or a counter store.
 */
export async function assistantEmbedOperatorView(input: {
  readonly record: PublicEmbedRecord;
  readonly surface: PublicSurface | undefined;
  readonly envelope: AdmissionEnvelope;
  /** Usage without consuming. The keys are this package's own convention, so it forms them here. */
  readonly peek: (key: string) => Promise<number>;
  /** Present only when Noodle funds this surface's model. */
  readonly spend?: { readonly key: string; readonly allowance: number };
}): Promise<AssistantEmbedOperatorView> {
  const { record, surface, envelope, spend } = input;
  return {
    embedId: record.embedId,
    surfaceMode: surface?.mode ?? record.surfaceMode,
    origins: surface?.origins ?? [],
    capabilities: surface?.capabilities.map((entry) => entry.name) ?? [],
    turnsPerDay: envelope.turnsPerDay,
    mintsPerDay: envelope.mintsPerDay,
    bridgeCallsPerSession: envelope.bridgeToolCallsPerSession,
    bridgeCallsPerDay: envelope.bridgeToolCallsPerDay,
    budgetIsDefault:
      record.turnsPerDay === undefined &&
      record.mintsPerDay === undefined &&
      record.bridgeToolCallsPerSession === undefined &&
      record.bridgeToolCallsPerDay === undefined,
    turnsToday: await input.peek(`turns:${record.embedId}`),
    mintsToday: await input.peek(`mints:${record.embedId}`),
    // Keyed as `admitBridgeToolCall` writes it, so the number an operator reads is the one the
    // gate consumed rather than a parallel count that can drift from it.
    bridgeCallsToday: await input.peek(`bridge:${record.embedId}`),
    createdAt: record.createdAt.toISOString(),
    ...(spend === undefined
      ? {}
      : {
          managedSpend: assistantManagedSpendView({
            spend,
            unitsUsed: await input.peek(spend.key),
          }),
        }),
  };
}

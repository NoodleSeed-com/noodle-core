import {
  ADMISSION_DEFAULTS,
  type AdmissionEnvelope,
  type DailyCounterStore,
  isDisabled,
} from '@noodle-borg/admission-limits/portable';
import type {
  AssistantSessionRecord,
  AssistantStore,
  AssistantTurnConsumption,
} from './assistant-store.js';
import type { PublicEmbedRecord, PublicEmbedStore } from './embed-store.js';
import type { ManagedAssistantModelResolver } from './model-request.js';
import { type SurfaceBudgetBounds, surfaceEnvelope } from './surface-budget.js';

/**
 * Whether an anonymous visitor's next turn runs.
 *
 * Transport-free for the same reason {@link ./public-session.ts} is: the decision about who gets to spend
 * a customer's model budget should be provable without standing up a server. The service adapts it.
 *
 * The envelope arrives per call rather than being snapshotted onto the session at mint time, and that is
 * load-bearing: `noodle assistant budget set --turns-per-day 0` must stop conversations already under
 * way, which is precisely the case an operator reaches for the kill switch to stop. Re-reading it each
 * turn makes the switch fall out of the ordinary path instead of needing a second mechanism.
 */

export interface PublicTurnPorts {
  readonly counters: DailyCounterStore;
  /** Re-read per turn: it carries the operator's live budget, and whether the surface still exists. */
  readonly embeds: Pick<PublicEmbedStore, 'lookup'>;
  /** Optional hosted entitlement; resolved live so cohort removal lowers the envelope immediately. */
  readonly resolveBudgetBounds?: (
    embed: PublicEmbedRecord,
  ) => Promise<SurfaceBudgetBounds | undefined>;
  /** Spend one of this session's turns, atomically (admission tier 1). */
  consumeTurn(id: string, limit: number): Promise<AssistantTurnConsumption>;
  now(): Date;
}

export interface PublicTurnRequest {
  readonly sessionId: string;
  /** The surface the session was admitted through; daily spend is charged against it. */
  readonly publicEmbedId: string;
  readonly message: string;
  /**
   * The visitor's hashed address bucket (admission tier 3), or absent when ingress could not be parsed.
   * A raw address must never reach this decision, a counter key, or an audit payload.
   */
  readonly addressBucket?: string | undefined;
}

export type PublicTurnResult =
  | { readonly ok: true; readonly turnCount: number }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export interface AssistantPublicTurnDeps {
  readonly publicEmbeds?: PublicEmbedStore;
  readonly admissionCounters?: DailyCounterStore;
  readonly admissionEnvelope?: AdmissionEnvelope;
  readonly managedModelResolver?: ManagedAssistantModelResolver;
  readonly store: Pick<AssistantStore, 'consumeTurn'>;
  readonly clock?: () => Date;
}

export interface PublicTurnRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** Adapt a session plus serving ports to the transport-free public-turn decision below. */
export async function refusePublicTurn(
  deps: AssistantPublicTurnDeps,
  session: AssistantSessionRecord,
  message: string,
  addressBucket: string | undefined,
): Promise<PublicTurnRefusal | undefined> {
  const publicEmbedId = session.publicEmbedId;
  if (publicEmbedId === undefined) return undefined;
  if (!deps.publicEmbeds || !deps.admissionCounters) {
    return {
      status: 503,
      code: 'admission_unavailable',
      message: 'assistant is unavailable right now',
    };
  }
  const result = await admitPublicTurn(
    { sessionId: session.id, publicEmbedId, message, ...(addressBucket ? { addressBucket } : {}) },
    deps.admissionEnvelope ?? ADMISSION_DEFAULTS,
    {
      counters: deps.admissionCounters,
      embeds: deps.publicEmbeds,
      resolveBudgetBounds: async () =>
        session.modelSource !== 'noodle-managed'
          ? undefined
          : (
              await deps.managedModelResolver?.resolve({
                tenant: session.tenant,
                deploymentId: session.deploymentId,
              })
            )?.publicAdmission,
      consumeTurn: (id, limit) => deps.store.consumeTurn(id, limit),
      now: () => deps.clock?.() ?? new Date(),
    },
  );
  return result.ok
    ? undefined
    : { status: result.status, code: result.code, message: result.message };
}

/**
 * The same gate in front of a WebMCP bridge tool call (ADR 0220). A browser agent can call governed
 * tools without ever running a model turn, so the turn budget above would never refuse it.
 */
export async function refuseBridgeToolCall(
  deps: AssistantPublicTurnDeps,
  session: AssistantSessionRecord,
): Promise<PublicTurnRefusal | undefined> {
  const publicEmbedId = session.publicEmbedId;
  if (publicEmbedId === undefined) return undefined;
  if (!deps.publicEmbeds || !deps.admissionCounters) {
    return {
      status: 503,
      code: 'admission_unavailable',
      message: 'assistant is unavailable right now',
    };
  }
  const result = await admitBridgeToolCall(
    { sessionId: session.id, publicEmbedId },
    deps.admissionEnvelope ?? ADMISSION_DEFAULTS,
    {
      counters: deps.admissionCounters,
      embeds: deps.publicEmbeds,
      // Resolved live rather than snapshotted, so removing a surface from a sponsored cohort lowers
      // its envelope immediately instead of at the next mint.
      resolveBudgetBounds: async () =>
        session.modelSource !== 'noodle-managed'
          ? undefined
          : (
              await deps.managedModelResolver?.resolve({
                tenant: session.tenant,
                deploymentId: session.deploymentId,
              })
            )?.publicAdmission,
      now: () => deps.clock?.() ?? new Date(),
    },
  );
  return result.ok
    ? undefined
    : { status: result.status, code: result.code, message: result.message };
}

export async function admitPublicTurn(
  request: PublicTurnRequest,
  defaults: AdmissionEnvelope,
  ports: PublicTurnPorts,
): Promise<PublicTurnResult> {
  // Cheapest first, so an oversized body costs neither a session slot nor surface budget. The public
  // bound is narrower than the shared request schema's, which stays as it is for authenticated callers.
  if (request.message.length > defaults.messageCharacters) {
    return {
      ok: false,
      status: 400,
      code: 'message_too_long',
      message: `message must be at most ${defaults.messageCharacters} characters`,
    };
  }

  // Revoking an embed used to stop new mints while leaving conversations already under way talking.
  // Reading the record here — which the budget override requires anyway — closes that: a surface that
  // is gone stops serving the sessions it already admitted.
  const embed = await ports.embeds.lookup(request.publicEmbedId);
  if (embed === undefined) {
    return {
      ok: false,
      status: 403,
      code: 'embed_not_found',
      message: 'assistant is unavailable right now',
    };
  }
  const budgetBounds = await ports.resolveBudgetBounds?.(embed);
  const envelope = surfaceEnvelope(defaults, embed, budgetBounds);

  // Fairness before either of the budgets below: an address at its hourly ceiling is turned away
  // without spending the session's allowance or the customer's day, so one visitor cannot burn either
  // on turns that were never served. Mirrors the ordering the mint uses.
  if (typeof request.addressBucket === 'string') {
    const perAddress = await ports.counters.consume(
      {
        key: `turns:addr:${request.publicEmbedId}:${request.addressBucket}`,
        limit: envelope.turnsPerAddressHour,
        window: 'hour',
      },
      ports.now(),
    );
    if (!perAddress.allowed) {
      return {
        ok: false,
        status: 429,
        code: 'address_turn_budget_exhausted',
        message: 'assistant is unavailable right now',
      };
    }
  }

  // The session's own allowance is checked before the surface's, so a session with nothing left cannot
  // spend the customer's daily budget on a turn that is refused a moment later.
  const session = await ports.consumeTurn(request.sessionId, envelope.turnsPerSession);
  if (!session.allowed) {
    return {
      ok: false,
      status: 429,
      code: 'session_turn_budget_exhausted',
      message: 'this conversation has reached its length limit',
    };
  }

  const surface = await ports.counters.consume(
    { key: `turns:${request.publicEmbedId}`, limit: envelope.turnsPerDay },
    ports.now(),
  );
  if (!surface.allowed) {
    // Calm and distinct: the widget renders "back soon" rather than an error, and an operator reading
    // the code sees a surface that is spent or switched off, not a broken deployment.
    return {
      ok: false,
      status: 429,
      code: 'daily_turn_budget_exhausted',
      message: 'assistant is unavailable right now',
    };
  }

  // Platform spend last, when someone other than the customer is paying. Every counter here is
  // all-or-nothing with no refund, so whichever runs first is charged for turns the ones after it
  // refuse — and a session ending at its length limit is ordinary traffic, many times a day, while
  // spend exhaustion is rare and for one day only. Charging the sponsor for every visitor's last
  // turn is the worse of the two leaks, so this is the counter that goes last.
  //
  // It reports the surface's own exhaustion code on purpose: every published widget already treats
  // `daily_turn_budget_exhausted` as final, and a new code would be read as retryable by all of them
  // — precisely the load this ceiling exists to refuse. At the ladder's closing rung the surface
  // ceiling is already zero, so that refusal arrives above; this is the backstop between rungs.
  if (budgetBounds?.spend !== undefined) {
    const { key, units, allowance } = budgetBounds.spend;
    const spend = await ports.counters.consume(
      { key, limit: allowance, amount: units },
      ports.now(),
    );
    if (!spend.allowed) {
      return {
        ok: false,
        status: 429,
        code: 'daily_turn_budget_exhausted',
        message: 'assistant is unavailable right now',
      };
    }
  }

  return { ok: true, turnCount: session.turnCount };
}

/**
 * Whether a browser agent's next bridge tool call runs (ADR 0220).
 *
 * Separate from {@link admitPublicTurn} because a WebMCP call is not a turn: it spends no model budget,
 * so the turn caps would never refuse it however long an agent kept going. It still reaches connectors
 * and customer backends, so it gets its own pair of bounds — and, like every other admission decision
 * here, the envelope is read per call so an operator lowering a cap stops traffic already under way.
 *
 * Authority is not decided here and never could be: this runs *after* the route has authenticated the
 * session, and the call it admits still goes through tool authorization and confirmation downstream.
 */
export interface BridgeToolCallPorts {
  readonly counters: DailyCounterStore;
  readonly embeds: Pick<PublicEmbedStore, 'lookup'>;
  readonly resolveBudgetBounds?: (
    embed: PublicEmbedRecord,
  ) => Promise<SurfaceBudgetBounds | undefined>;
  now(): Date;
}

export interface BridgeToolCallRequest {
  readonly sessionId: string;
  readonly publicEmbedId: string;
}

export type BridgeToolCallResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export async function admitBridgeToolCall(
  request: BridgeToolCallRequest,
  defaults: AdmissionEnvelope,
  ports: BridgeToolCallPorts,
): Promise<BridgeToolCallResult> {
  try {
    const embed = await ports.embeds.lookup(request.publicEmbedId);
    if (embed === undefined) {
      return {
        ok: false,
        status: 403,
        code: 'embed_not_found',
        message: 'assistant is unavailable right now',
      };
    }
    const budgetBounds = await ports.resolveBudgetBounds?.(embed);
    const envelope = surfaceEnvelope(defaults, embed, budgetBounds);

    // One kill switch, not two. An operator who zeroes a surface's day means all of it, including the
    // tools a page agent can reach without ever running a turn.
    if (isDisabled(envelope)) return bridgeBudgetExhausted('daily');

    // The session's own allowance first, so a session with nothing left cannot spend the customer's
    // day on a call that is refused a moment later. Mirrors the turn path's ordering.
    const session = await ports.counters.consume(
      {
        key: `bridge:ses:${request.sessionId}`,
        limit: envelope.bridgeToolCallsPerSession,
      },
      ports.now(),
    );
    if (!session.allowed) return bridgeBudgetExhausted('session');

    const surface = await ports.counters.consume(
      { key: `bridge:${request.publicEmbedId}`, limit: envelope.bridgeToolCallsPerDay },
      ports.now(),
    );
    if (!surface.allowed) return bridgeBudgetExhausted('daily');

    return { ok: true };
  } catch {
    // Fail closed. A counter store we cannot reach is a budget we cannot enforce, and an unbounded
    // agent loop against a customer's backend is the exact outcome these caps exist to prevent.
    return {
      ok: false,
      status: 503,
      code: 'bridge_admission_unavailable',
      message: 'assistant is unavailable right now',
    };
  }
}

function bridgeBudgetExhausted(scope: 'session' | 'daily'): BridgeToolCallResult {
  return {
    ok: false,
    status: 429,
    code: `${scope}_bridge_budget_exhausted`,
    message: 'assistant is unavailable right now',
  };
}

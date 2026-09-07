/**
 * The public-surface safety envelope (ADR 0201 §7, amended 2026-08-12).
 *
 * Two ideas are deliberately separate here:
 *
 * - **Structural maximums** are the ceiling neither app code nor managed config may raise. They exist
 *   because a public surface faces the open internet, and "the author configured it" is not a reason to
 *   trust a larger bound.
 * - **Operator defaults** are what a surface gets when nobody says otherwise. Operators may lower any of
 *   them, and lowering the daily caps to zero is the kill switch — one mechanism, not two.
 *
 * `clamp()` is the only way to build an envelope, so raising a bound is unrepresentable rather than
 * merely discouraged.
 */

export interface AdmissionEnvelope {
  /** Longest visitor message accepted, in characters. */
  readonly messageCharacters: number;
  /** Model turns one session may run before it must be replaced. */
  readonly turnsPerSession: number;
  /** Model steps inside a single turn (the agent loop bound). */
  readonly modelStepsPerTurn: number;
  /** Tool calls inside a single turn, across all steps. */
  readonly toolCallsPerTurn: number;
  /** Inputs or confirmations that may be outstanding on one session at a time. */
  readonly pendingInteractions: number;
  /** Lifetime of a single-use confirmation, in milliseconds. */
  readonly confirmationTtlMs: number;
  /** Idle timeout before a session is unusable, in milliseconds. */
  readonly sessionIdleMs: number;
  /** Absolute session lifetime regardless of activity, in milliseconds. */
  readonly sessionAbsoluteMs: number;
  /**
   * Model turns this surface may run per UTC day. This is the solvency bound: it caps what a bot can
   * spend of the customer's model budget without depending on client-IP attribution.
   */
  readonly turnsPerDay: number;
  /**
   * Sessions this surface may mint per UTC day. Turns alone are not enough — a bot that only mints
   * writes durable session rows forever while spending nothing.
   */
  readonly mintsPerDay: number;
  /**
   * Sessions one source address may mint per hour, and turns it may run (admission tier 3).
   *
   * A different question from the daily caps, which is why it is a separate tier rather than a tighter
   * number: the per-surface cap governs **solvency** — the customer's model spend is bounded whatever
   * happens — while this governs **fairness**, so one visitor cannot consume the surface's whole day
   * before anybody else arrives. Losing this tier loses fairness and never solvency, which is why the
   * pilot shipped without it.
   */
  readonly mintsPerAddressHour: number;
  readonly turnsPerAddressHour: number;
  /**
   * Sessions one *visitor* may mint per hour (admission tier 4).
   *
   * A finer question than the address tier, and the one the address tier gets wrong. A corporate NAT,
   * a university, a coworking space, or a mobile carrier's CGNAT put hundreds of unrelated people
   * behind one address; without this they race each other for a single visitor's allowance and the
   * ones who lose cannot tell the refusal from a broken product.
   *
   * The identifier is supplied by the browser, so this is fairness and never abuse control — it can
   * be rotated at will. The address tier stays underneath as the bound that cannot be rotated, which
   * is why this one is checked first: a visitor at their own ceiling is refused without spending any
   * of the shared address allowance.
   */
  readonly mintsPerVisitorHour: number;
  /**
   * Tool calls one session may make through the WebMCP provider bridge (ADR 0220).
   *
   * A separate bound from `turnsPerSession` because a browser agent calling a governed tool spends no
   * model turn: the turn budget would never refuse it however long the agent kept going. These calls
   * still reach connectors and customer backends, so they need a ceiling of their own.
   */
  readonly bridgeToolCallsPerSession: number;
  /** Bridge tool calls this surface may serve per UTC day — the solvency bound for agent traffic. */
  readonly bridgeToolCallsPerDay: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Ceilings. Nothing may exceed these, whatever the manifest or managed config asks for.
 *
 * Raised for web scale on 2026-08-31. These are release-level decisions, not runtime ones: an
 * operator may still only lower a bound, and code may still not raise one. What changed is that the
 * pilot's numbers made a busy site meet an unraisable constant — a 100k-visitor site went dark after
 * 300 conversations — so the ceiling now sits well above any legitimate site rather than just above
 * the pilot.
 */
export const ADMISSION_MAXIMUM: AdmissionEnvelope = Object.freeze({
  messageCharacters: 4_000,
  turnsPerSession: 40,
  modelStepsPerTurn: 6,
  toolCallsPerTurn: 8,
  pendingInteractions: 1,
  confirmationTtlMs: 10 * MINUTE,
  sessionIdleMs: 30 * MINUTE,
  sessionAbsoluteMs: 2 * HOUR,
  turnsPerDay: 2_000_000,
  mintsPerDay: 500_000,
  mintsPerAddressHour: 20_000,
  turnsPerAddressHour: 100_000,
  mintsPerVisitorHour: 1_000,
  bridgeToolCallsPerSession: 200,
  bridgeToolCallsPerDay: 200_000,
});

/**
 * What a surface gets when nobody configures it.
 *
 * Sized for a busy public website — roughly 100k visitors a day at ordinary engagement, with headroom
 * — rather than for a pilot. The pilot's 300 mints and 1,000 turns were the right numbers for proving
 * the mechanism and the wrong ones for shipping it: a customer who succeeded went dark by midday.
 *
 * The two per-address bounds are now *abuse* bounds rather than fairness ones. Tier 4 gives each
 * visitor their own allowance, so these only have to be low enough to stop a single machine and high
 * enough never to be met by a corporate NAT with hundreds of real people behind it.
 */
export const ADMISSION_DEFAULTS: AdmissionEnvelope = Object.freeze({
  ...ADMISSION_MAXIMUM,
  turnsPerDay: 20_000,
  mintsPerDay: 5_000,
  mintsPerAddressHour: 300,
  turnsPerAddressHour: 1_200,
  // Fairness, and generous on purpose: thirty conversations an hour is far past ordinary use, and a
  // visitor who somehow reaches it is still bounded by everything above.
  mintsPerVisitorHour: 30,
  // A browser agent works in bursts of reads. The web-scale raise above deliberately left these at
  // ADR 0220's sizing, on the reasoning that agent traffic is a different question from visitor
  // traffic and an unmeasured bound should not be re-tuned in passing. That reasoning holds; what it
  // left behind does not. 32 per session sits beside an assistant path that already spends
  // `turnsPerSession` x `toolCallsPerTurn` = 320 tool calls against the same connectors, and a bridge
  // call is the cheaper of the two because it runs no model — so the tighter bound was on the
  // cheaper caller, by an order of magnitude. These bring it back to the same order: a session's
  // bridge allowance is a little under a third of its tool calls, and its day matches `turnsPerDay`.
  // Proportionate, not measured. Both remain guesses, which is the actual argument for the operator
  // overrides that now exist: the number stops needing a release to change.
  bridgeToolCallsPerSession: 100,
  bridgeToolCallsPerDay: 20_000,
});

/**
 * Build an envelope from an operator request. Every field is clamped to {@link ADMISSION_MAXIMUM};
 * a request below the ceiling is honoured exactly, and a request above it is silently reduced rather
 * than rejected, so a stale or over-eager configuration degrades to safe instead of failing a surface
 * closed at request time. Zero is meaningful for the daily caps and is preserved.
 */
export function clamp(requested: Partial<AdmissionEnvelope> = {}): AdmissionEnvelope {
  const bound = (key: keyof AdmissionEnvelope): number => {
    const value = requested[key];
    if (value === undefined || !Number.isFinite(value) || value < 0) return ADMISSION_DEFAULTS[key];
    return Math.min(Math.floor(value), ADMISSION_MAXIMUM[key]);
  };
  return {
    messageCharacters: bound('messageCharacters'),
    turnsPerSession: bound('turnsPerSession'),
    modelStepsPerTurn: bound('modelStepsPerTurn'),
    toolCallsPerTurn: bound('toolCallsPerTurn'),
    pendingInteractions: bound('pendingInteractions'),
    confirmationTtlMs: bound('confirmationTtlMs'),
    sessionIdleMs: bound('sessionIdleMs'),
    sessionAbsoluteMs: bound('sessionAbsoluteMs'),
    turnsPerDay: bound('turnsPerDay'),
    mintsPerAddressHour: bound('mintsPerAddressHour'),
    turnsPerAddressHour: bound('turnsPerAddressHour'),
    mintsPerVisitorHour: bound('mintsPerVisitorHour'),
    mintsPerDay: bound('mintsPerDay'),
    bridgeToolCallsPerSession: bound('bridgeToolCallsPerSession'),
    bridgeToolCallsPerDay: bound('bridgeToolCallsPerDay'),
  };
}

/** A surface whose daily budget is exhausted or switched off serves nobody until it is raised. */
export function isDisabled(envelope: AdmissionEnvelope): boolean {
  return envelope.turnsPerDay === 0 || envelope.mintsPerDay === 0;
}

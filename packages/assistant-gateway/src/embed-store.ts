/**
 * Public embed identifiers.
 *
 * These live in their own table rather than as a flag on the authenticated `assistant_clients` row, and
 * the reason is structural rather than tidiness: a public embed id is printed in page source, so it must
 * never be a credential. A record with no secret column cannot accidentally acquire one — there is
 * nothing for a future code path to populate, hash, or compare. Reusing the client table would have
 * inherited its tooling for free while keeping a `secret_hash` one bug away from a public identifier.
 *
 * The id is stable across deploys. A customer pastes the snippet once; redeploys and rollbacks swap the
 * projection underneath a page that never changes. Origins, capabilities, and UI therefore come from the
 * *active* deployment at mint time, never from the embed record.
 */

export interface PublicEmbedRecord {
  /** Printed in page source. Non-secret by construction. */
  readonly embedId: string;
  readonly org: string;
  readonly app: string;
  readonly env: string;
  /**
   * Which surface of the assistant this id addresses, so budgets and kill switches key per surface.
   * Provisioning-time record only: `ensure` never updates a live row, so this goes stale when a
   * redeploy changes the mode — readers report the active deployment's mode instead.
   */
  readonly surfaceMode: 'public' | 'mixed';
  readonly createdAt: Date;
  readonly revokedAt?: Date;
  /**
   * Operator overrides for this surface's daily caps. Undefined means "use the deployment defaults";
   * `0` is a real value and is the kill switch, so the two must stay distinguishable everywhere.
   */
  readonly turnsPerDay?: number;
  readonly mintsPerDay?: number;
  /**
   * Operator overrides for the per-address abuse bounds. Rarely needed — tier 4 handles fairness and
   * these only have to stop a single machine — but an operator who knows their own traffic shape
   * (an internal tool behind one proxy, say) can lower them, and lowering is all anyone may do.
   */
  readonly mintsPerAddressHour?: number;
  readonly turnsPerAddressHour?: number;
  /**
   * Operator overrides for this surface's WebMCP bridge budgets. The shipped defaults are
   * proportionate rather than measured (ADR 0220), so an operator who can see their own agent
   * traffic needs to move them without waiting for a release. `0` is the kill switch here too,
   * though zeroing `turnsPerDay` already stops bridge calls with it.
   */
  readonly bridgeToolCallsPerSession?: number;
  readonly bridgeToolCallsPerDay?: number;
}

/** Project the non-secret embed coordinate onto the shared assistant tenant shape. */
export function publicEmbedTenant(embed: PublicEmbedRecord): TenantRef {
  return { org: embed.org, app: embed.app, env: embed.env };
}

/** What an operator may change about a surface. An omitted field leaves that cap as it was. */
export interface PublicEmbedBudget {
  readonly turnsPerDay?: number;
  readonly mintsPerDay?: number;
  readonly mintsPerAddressHour?: number;
  readonly turnsPerAddressHour?: number;
  readonly bridgeToolCallsPerSession?: number;
  readonly bridgeToolCallsPerDay?: number;
}

export interface PublicEmbedStore {
  /**
   * Return the existing id for this tenant surface, or create one. Deploy calls this, so it must be
   * idempotent: a redeploy that minted a fresh id would silently break every page already carrying the
   * old one.
   */
  ensure(input: {
    readonly org: string;
    readonly app: string;
    readonly env: string;
    readonly surfaceMode: 'public' | 'mixed';
    readonly now: Date;
    /** Installation recovery preserves revocation; explicit redeploy may replace it by default. */
    readonly allowRevokedReplacement?: boolean;
  }): Promise<PublicEmbedRecord>;
  /** Resolve an id presented by a browser. Revoked ids resolve to undefined. */
  lookup(embedId: string): Promise<PublicEmbedRecord | undefined>;
  /**
   * Raise, lower, or switch off a surface's daily caps. Separate from `ensure` on purpose: `ensure` runs
   * on every deploy and never overwrites a live row, so a redeploy cannot reset an operator's decision.
   */
  setBudget(
    embedId: string,
    budget: PublicEmbedBudget,
    now: Date,
  ): Promise<PublicEmbedRecord | undefined>;
  list(
    tenant: {
      readonly org: string;
      readonly app: string;
      readonly env: string;
    },
    options?: { readonly includeRevoked?: boolean },
  ): Promise<readonly PublicEmbedRecord[]>;
  revoke(embedId: string, now: Date): Promise<boolean>;
}

/**
 * `pub_` prefixed so it is self-describing in page source, logs, and support threads — someone reading a
 * customer's HTML can tell at a glance that it is not a secret that leaked.
 */
export const PUBLIC_EMBED_ID_PREFIX = 'pub_';

export function isPublicEmbedId(value: string): boolean {
  return new RegExp(`^${PUBLIC_EMBED_ID_PREFIX}[0-9a-z]{20,32}$`).test(value);
}

import type { TenantRef } from './tenant-ref.js';

/**
 * Validate an operator's requested caps.
 *
 * Lives with the budget type rather than with the route that receives it: the rules are about what a
 * cap may be, not about HTTP, and a second caller must not be able to reach the store with a shape
 * this would have rejected.
 */
export type BudgetField =
  | 'turnsPerDay'
  | 'mintsPerDay'
  | 'mintsPerAddressHour'
  | 'turnsPerAddressHour'
  | 'bridgeToolCallsPerSession'
  | 'bridgeToolCallsPerDay';
type BudgetValue = Partial<Record<BudgetField, number>>;
type ParsedBudget =
  | { readonly ok: true; readonly value: BudgetValue }
  | { readonly ok: false; readonly error: string };

const BUDGET_FIELDS: readonly BudgetField[] = [
  'turnsPerDay',
  'mintsPerDay',
  'mintsPerAddressHour',
  'turnsPerAddressHour',
  'bridgeToolCallsPerSession',
  'bridgeToolCallsPerDay',
];

export function parsePublicEmbedBudget(body: unknown): ParsedBudget {
  // A JSON body of `null` is an object to `typeof` and reads as a crash to a property access, so it
  // is checked by name: an operator sending nonsense deserves the 400 this returns, not the 500 an
  // uncaught `TypeError` would become.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const supplied = body as Partial<Record<BudgetField, unknown>>;
  const value: BudgetValue = {};
  for (const [name, raw] of BUDGET_FIELDS.map((field) => [field, supplied[field]] as const)) {
    if (raw === undefined) continue;
    // Zero is valid and is the point; anything negative or fractional is a mistake worth saying out
    // loud rather than silently flooring, because an operator setting a cap is being deliberate.
    // `isSafeInteger` rather than `isInteger`: past 2^53 a JSON number has already lost the value
    // the operator typed, and it reaches a `::bigint` column that would store the rounded one.
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      return { ok: false, error: `"${name}" must be a non-negative integer` };
    }
    value[name] = raw;
  }
  if (Object.keys(value).length === 0) {
    return {
      ok: false,
      error: `set at least one of ${BUDGET_FIELDS.map((f) => `"${f}"`).join(', ')}`,
    };
  }
  return { ok: true, value };
}

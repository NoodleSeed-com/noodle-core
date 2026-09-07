import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantRef } from './tenant-ref.js';

/**
 * Anonymous cross-page display continuity (ADR 0223, clauses 11-16).
 *
 * **A display handle, not a session.** Claiming one returns the conversation's visible text for
 * rendering and mints a fresh session; it never revives the original, and grants no tool authority, no
 * share of a spent turn budget, and no bound surface. Deliberately unlike the authenticated reattach in
 * clause 7, it restores no view descriptor and no pending interaction — a capability that survives a
 * navigation is exactly what this design refuses to create.
 *
 * **Its bounds are shaped by one asymmetry.** A sign-in ticket is safe partly because possession alone
 * is worthless: spending one also requires the customer's client credentials, held server-side. An
 * anonymous visitor has no such credential and no server-side counterpart, so possession of a handle is
 * *sufficient by itself*. Hence four independent bounds — single use, a short window, binding to the
 * context it was issued to, and a chain that ends — rather than any one of them carrying the weight.
 */

/** What a handle is bound to. All three are hashes; no raw origin or visitor id is ever stored. */
export interface AssistantContinuityContext {
  readonly embedId: string;
  readonly originHash: string;
  readonly visitorHash: string;
}

export interface AssistantContinuityRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tenant: TenantRef;
  readonly context: AssistantContinuityContext;
  readonly handleHash: string;
  /** Restores already spent on this conversation, carried across every rotation. */
  readonly restoreCount: number;
  /** Clamped at issue time and stored, so a record describes its own limit rather than trusting a caller. */
  readonly maxRestores: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
}

export type AssistantContinuityClaim =
  | {
      readonly ok: true;
      readonly record: AssistantContinuityRecord;
      /**
       * The rotated handle for the next navigation, or `undefined` once the chain is spent. Withholding
       * it is how continuity ends: the visitor still sees the text they were promised, and the next page
       * simply has nothing to present, so no refusal code is needed for an ordinary ending.
       */
      readonly handle?: string;
    }
  | {
      readonly ok: false;
      /**
       * One code per refusal, because they are operationally different: `unknown` is a bad or already
       * spent handle, `expired` is a visitor who took too long, and `context_mismatch` is a handle
       * presented from an embed, origin, or visitor it was not issued to — the exfiltration signal, and
       * the one worth alerting on, so it must not collapse into the first.
       */
      readonly reason: 'unknown' | 'expired' | 'context_mismatch';
    };

/** Five minutes: long enough to read a page before clicking through, short enough to bound a leak. */
export const ASSISTANT_CONTINUITY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Ten minutes, the sign-in ticket's own TTL: an anonymous display handle must never outlive the
 * authenticated capability it is modelled on, whatever a developer or operator asks for.
 */
export const ASSISTANT_CONTINUITY_WINDOW_CEILING_MS = 10 * 60 * 1000;

/** Three restores covers the engaged visitor's page depth without letting a chain run indefinitely. */
export const ASSISTANT_CONTINUITY_MAX_RESTORES = 3;

/** Past ten, chain length stops being a meaningful control, so no configuration may exceed it. */
export const ASSISTANT_CONTINUITY_RESTORE_CEILING = 10;

/**
 * Clamp a requested bound the way the admission envelope does: one direction only.
 *
 * Zero is the deploy-free kill switch, and anything malformed — negative, fractional, NaN — collapses to
 * zero rather than to the default. A typo must fail closed here: unlike a spend allowance, where an
 * outage is worse than a day of unbudgeted cost, a continuity handle is a capability, and the safe
 * failure for a capability is not to exist.
 */
function clampBound(requested: number | undefined, fallback: number, ceiling: number): number {
  if (requested === undefined) return fallback;
  if (!Number.isInteger(requested) || requested < 0) return 0;
  return Math.min(requested, ceiling);
}

export function continuityWindowMs(requested?: number): number {
  return clampBound(
    requested,
    ASSISTANT_CONTINUITY_WINDOW_MS,
    ASSISTANT_CONTINUITY_WINDOW_CEILING_MS,
  );
}

export function continuityMaxRestores(requested?: number): number {
  return clampBound(
    requested,
    ASSISTANT_CONTINUITY_MAX_RESTORES,
    ASSISTANT_CONTINUITY_RESTORE_CEILING,
  );
}

export interface AssistantContinuityStore {
  /**
   * Issue this session's handle for the next navigation, superseding any unclaimed one so a
   * conversation never accumulates one live key per turn.
   *
   * Returns `undefined` when the effective window or chain clamps to zero. The kill switch is enforced
   * here rather than at the call site, so a caller that forgets to check cannot hand out a handle the
   * operator has switched off.
   */
  issue(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly context: AssistantContinuityContext;
    readonly windowMs?: number;
    readonly maxRestores?: number;
    readonly now: Date;
  }): Promise<{ readonly record: AssistantContinuityRecord; readonly handle: string } | undefined>;

  /**
   * Spend a handle exactly once, rotating to a fresh one until the chain is spent. Atomic: two backends
   * racing the same value must not both win, which is why this is one store seam rather than a
   * read-then-write in the route.
   */
  claim(input: {
    readonly handle: string;
    readonly context: AssistantContinuityContext;
    readonly now: Date;
  }): Promise<AssistantContinuityClaim>;

  /**
   * Drop spent and expired rows, returning how many went.
   *
   * Retention belongs to this store rather than to a caller that may forget: handles are short-lived and
   * must be swept, not accumulated. Cleanup may lag expiry safely, because `claim` already refuses a
   * stale handle — the sweep bounds the table, it does not enforce the window.
   */
  sweepExpired(input: { readonly now: Date }): Promise<number>;
}

export function continuityHandle(): string {
  return `cnt_${randomBytes(24).toString('base64url')}`;
}

export function continuityDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function continuityHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Every leg must match: a handle is only valid for the embed, origin, and visitor it was issued to. */
export function sameContinuityContext(
  left: AssistantContinuityContext,
  right: AssistantContinuityContext,
): boolean {
  return (
    left.embedId === right.embedId &&
    left.originHash === right.originHash &&
    left.visitorHash === right.visitorHash
  );
}

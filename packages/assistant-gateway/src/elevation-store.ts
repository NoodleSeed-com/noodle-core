import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantRef } from './tenant-ref.js';

/**
 * Mid-conversation sign-in on a `mixed` surface (ADR 0201, 5.6b).
 *
 * **Not an interaction record, deliberately.** The plan proposed a new `auth_requested` kind on the
 * existing interaction machinery, but that machinery is *visitor-resolvable*: accept/decline/cancel are
 * driven from the widget. An elevation resolved by a visitor click would be an elevation with no
 * credentials, so reusing it would have meant bolting a "this kind is not visitor-resolvable" exception
 * onto every resolution path and hoping none was missed. A separate record has no such path to forget.
 *
 * **The continuation is a capability that travels through the browser**, so possession alone must be
 * worthless: spending one also requires the customer's client credentials, and the claim checks that the
 * client's tenant owns the session. It is stored hashed for the same reason session tokens are — the
 * store never holds a value that could be replayed if it leaked.
 */

export interface AssistantElevationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly tenant: TenantRef;
  /** The capability the visitor was refused, carried so the audit says what they signed in for. */
  readonly tool: string;
  /** Canonical server-side snapshot of handles eligible when this ticket was issued. */
  readonly claimableStateHandles: readonly string[];
  readonly continuationHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly claimedAt?: string;
}

export type AssistantElevationClaim =
  | { readonly ok: true; readonly elevation: AssistantElevationRecord }
  | {
      readonly ok: false;
      /**
       * One code per refusal, because they are operationally different: `unknown` is a bad or already
       * spent continuation, `expired` is a visitor who took too long, and `tenant_mismatch` is a client
       * spending a continuation for a conversation it does not own — the last is the one worth alerting
       * on, so it must not collapse into the first.
       */
      readonly reason: 'unknown' | 'expired' | 'tenant_mismatch';
    };

/** Ten minutes: long enough for a real login round trip, short enough that a leaked value is stale. */
export const ASSISTANT_ELEVATION_TTL_MS = 10 * 60 * 1000;

export interface AssistantElevationStore {
  /**
   * Open one elevation for a session. At most one may be live at a time — a second request supersedes
   * the first rather than accumulating, so a model that asks twice cannot mint unbounded capabilities.
   */
  request(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly tool: string;
    readonly claimableStateHandles?: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly elevation: AssistantElevationRecord; readonly continuation: string }>;
  /**
   * Spend a continuation exactly once. Atomic: two backends racing the same value must not both win,
   * which is why this is one store seam rather than a read-then-write in the route.
   */
  claim(input: {
    readonly continuation: string;
    readonly tenant: TenantRef;
    readonly now: Date;
  }): Promise<AssistantElevationClaim>;
}

export function elevationContinuation(): string {
  return `elv_${randomBytes(24).toString('base64url')}`;
}

export function elevationDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function elevationHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameTenant(left: TenantRef, right: TenantRef): boolean {
  return left.org === right.org && left.app === right.app && left.env === right.env;
}

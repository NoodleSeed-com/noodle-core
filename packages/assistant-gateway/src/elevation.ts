import type { AssistantPendingResume, AssistantSessionRecord } from './assistant-store.js';
import type { AssistantElevationStore } from './elevation-store.js';
import type { TenantRef } from './tenant-ref.js';

/**
 * The elevation decision, with no HTTP in it.
 *
 * Kept transport-free for the same reason `mintPublicSession` is: the interesting part is an ordering of
 * refusals, and an ordering is only testable without standing up a server. `packages/service` adapts.
 *
 * **The order is the contract.** The continuation is claimed *before* the session is touched, and the
 * claim is tenant-checked, so a client reaching for a conversation it does not own never reaches the
 * mutation at all. Claiming first also means a refused elevation cannot leave a spent continuation
 * behind — and a spent one cannot be replayed, which is the same statement read from the other side.
 */

export interface ElevationPorts {
  readonly elevations: Pick<AssistantElevationStore, 'claim'>;
  readonly elevateSession: (input: {
    readonly sessionId: string;
    readonly caller: AssistantSessionRecord['caller'];
    readonly clientId: string;
    readonly origin: string;
    readonly customerRouting?: AssistantSessionRecord['customerRouting'];
    readonly boundSurface?: AssistantSessionRecord['boundSurface'];
    readonly pendingResume?: AssistantPendingResume;
    readonly now: Date;
  }) => Promise<
    | { readonly ok: true; readonly session: AssistantSessionRecord; readonly token: string }
    | { readonly ok: false; readonly reason: 'unknown_session' | 'already_elevated' }
  >;
  readonly now: () => Date;
}

export interface ElevationRequest {
  /** Presented by the customer's backend. Possession alone is not enough; see the route. */
  readonly continuation: string;
  /** The tenant of the *authenticated client*, never a value the caller supplied loose. */
  readonly tenant: TenantRef;
  readonly caller: AssistantSessionRecord['caller'];
  /** The authenticated client's id: rebinds the session's issuer basis on success (ADR 0152). */
  readonly clientId: string;
  /**
   * Where the conversation continues: allowlist-validated by the route BEFORE the ticket is
   * claimed, then re-pinned onto the session so its CORS follows the visitor's post-login page.
   */
  readonly origin: string;
  /** Backend-verified customer routes, validated by the route; absent means unchanged. */
  readonly customerRouting?: AssistantSessionRecord['customerRouting'];
  /**
   * The surface that owns the (already validated) elevation origin: the conversation lands on that
   * surface's projection (ADR 0201 amendment 2026-08-26). Absent means unchanged — the pre-surfaces
   * artifact shape, which has no surfaces to land on.
   */
  readonly boundSurface?: AssistantSessionRecord['boundSurface'];
  /**
   * Arm the one-shot resume of the intercepted tool on success. Only an explicit `true` arms —
   * the route owns the default policy, and probes (the doctor's synthetic elevation) pass nothing.
   */
  readonly resume?: boolean;
}

export type ElevationResult =
  | {
      readonly ok: true;
      readonly session: AssistantSessionRecord;
      readonly token: string;
      /** What the visitor was refused before signing in, for the audit trail. */
      readonly tool: string;
      /** Whether one-shot auto-resume was actually armed after pending-interaction suppression. */
      readonly resumeArmed: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 403 | 409;
      readonly code:
        | 'elevation_ticket_invalid'
        | 'elevation_ticket_expired'
        | 'elevation_tenant_mismatch'
        | 'elevation_session_unavailable'
        | 'elevation_already_signed_in'
        | 'elevation_state_conflict';
    };

/** One commit boundary for ticket spend, state adoption, session rebind, and audit. */
export interface AssistantElevationCoordinator {
  complete(request: ElevationRequest): Promise<ElevationResult>;
}

export async function completeElevation(
  request: ElevationRequest,
  ports: ElevationPorts,
): Promise<ElevationResult> {
  const now = ports.now();
  const claimed = await ports.elevations.claim({
    continuation: request.continuation,
    tenant: request.tenant,
    now,
  });
  if (!claimed.ok) {
    // A wrong tenant reads as its own code rather than collapsing into "invalid": it is the one refusal
    // that means someone is reaching across a boundary, and an operator should be able to see it.
    if (claimed.reason === 'tenant_mismatch') {
      return { ok: false, status: 403, code: 'elevation_tenant_mismatch' };
    }
    return {
      ok: false,
      status: 403,
      code: claimed.reason === 'expired' ? 'elevation_ticket_expired' : 'elevation_ticket_invalid',
    };
  }

  const elevated = await ports.elevateSession({
    sessionId: claimed.elevation.sessionId,
    caller: request.caller,
    clientId: request.clientId,
    origin: request.origin,
    ...(request.customerRouting ? { customerRouting: request.customerRouting } : {}),
    ...(request.boundSurface ? { boundSurface: request.boundSurface } : {}),
    // Armed in the same statement that elevates: the claim happened above, so the intercepted
    // tool is in hand exactly when the session mutation runs.
    ...(request.resume === true
      ? { pendingResume: { tool: claimed.elevation.tool, requestedAt: now.toISOString() } }
      : {}),
    now,
  });
  if (!elevated.ok) {
    return {
      ok: false,
      status: 409,
      code:
        elevated.reason === 'already_elevated'
          ? 'elevation_already_signed_in'
          : 'elevation_session_unavailable',
    };
  }
  return {
    ok: true,
    session: elevated.session,
    token: elevated.token,
    tool: claimed.elevation.tool,
    resumeArmed: request.resume === true,
  };
}

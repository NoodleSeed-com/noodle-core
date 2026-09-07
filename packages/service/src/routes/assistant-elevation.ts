import type { ServerResponse } from 'node:http';
import type {
  AssistantElevationCoordinator,
  AssistantElevationStore,
  AssistantSessionRecord,
  AssistantStore,
  PublicSurface,
} from '@noodle-borg/assistant-gateway/portable';
import { completeElevation, publicSurfaceOf } from '@noodle-borg/assistant-gateway/portable';
import type { ArtifactState } from '@noodle-borg/compiler';
import { type ArtifactTool, anonymousBehavior } from '@noodle-borg/compiler';
import { claimableStateHandleNames } from '@noodle-borg/runtime';
import { sendJson } from '@noodle-borg/transport-http';
import { assistantSessionResponseSchema } from '@noodle-borg/wire-contracts';
import type { AuditSink } from '../store/audit.js';
import type { TenantRef } from '../store.js';

/**
 * Turning "you cannot do that" into "sign in and I will" (ADR 0201, 5.6b).
 *
 * On a `mixed` surface an identity-dependent capability is projected to anonymous visitors on purpose:
 * the model should be able to *offer* it, because offering is how the visitor learns signing in is worth
 * doing. What must never happen is the call proceeding — so the interception sits after authorization
 * and before dispatch, and returns an elevation request instead of a result.
 *
 * The sign-in ticket goes to the browser. That is safe only because spending one also requires the
 * customer's client credentials and a tenant match, both enforced where it is claimed; on its own it
 * names a conversation and nothing more. It is named `signInTicket` on the wire precisely because the
 * runtime's server-held interaction `continuation` has the opposite property — that one must never
 * reach browser code — and one word must not carry both contracts.
 */

export interface ElevationInterception {
  /** Streamed to the widget, which renders the sign-in card. */
  readonly event: {
    readonly event: 'auth_requested';
    readonly data: {
      readonly id: string;
      readonly tool: string;
      readonly signInTicket: string;
      /** Legacy alias of `signInTicket`: widgets published before the rename guard on this key. Drop at the next coordinated widget major (ADR 0151). */
      readonly continuation: string;
      readonly expiresAt: string;
    };
  };
  /** Fed back to the model as this tool call's result, so it explains rather than stalls. */
  readonly modelResult: string;
}

function isMixed(surface: PublicSurface | undefined): boolean {
  return surface?.mode === 'mixed';
}

/** Whether this assistant's public surface can turn a denial into a sign-in offer (ADR 0201, 5.6b). */
export function offersSignIn(assistant: unknown): boolean {
  return isMixed(publicSurfaceOf(assistant));
}

/** Human halves of the refusal envelope; the machine half is the gateway's `ElevationResult` code. */
const ELEVATION_REFUSAL_MESSAGES = {
  elevation_ticket_invalid: 'sign-in ticket is not valid or was already used',
  elevation_ticket_expired: 'sign-in ticket has expired; ask the visitor to retry the action',
  elevation_tenant_mismatch: 'sign-in ticket belongs to a different tenant',
  elevation_session_unavailable: 'the conversation behind this sign-in is no longer available',
  elevation_already_signed_in: 'this conversation is already signed in',
  elevation_state_conflict:
    'the signed-in account already has state at the same key; restart or resolve that draft first',
} as const satisfies Record<
  Extract<Awaited<ReturnType<typeof completeElevation>>, { ok: false }>['code'],
  string
>;

/**
 * Decide whether this call is an elevation instead of an execution.
 *
 * Returns `undefined` for every ordinary case — a signed-in caller, a public-safe tool, a surface that
 * is not mixed — so the caller's happy path is unchanged and only the one case diverts.
 */
export async function interceptForElevation(input: {
  readonly tool: ArtifactTool;
  readonly session: AssistantSessionRecord;
  readonly assistant: unknown;
  readonly state?: ArtifactState;
  readonly elevations: AssistantElevationStore | undefined;
  /**
   * The connector-auth-kind half of the classification (ADR 0201, amended 2026-08-19):
   * `anonymousBehavior` cannot see connector bindings, so the caller joins them in. Absent
   * resolver = the `${user}`/authorization classification alone, which fails closed to the
   * ordinary refusal — never an offer the deployment cannot complete.
   */
  readonly requiresDelegatedIdentity?: (tool: ArtifactTool) => boolean;
  readonly now: Date;
}): Promise<ElevationInterception | undefined> {
  if (input.session.caller.identityKind !== 'anonymous') return undefined;
  if (
    anonymousBehavior(input.tool) !== 'requires-identity' &&
    input.requiresDelegatedIdentity?.(input.tool) !== true
  ) {
    return undefined;
  }
  if (!offersSignIn(input.assistant)) return undefined;
  // A deployment without the store configured cannot offer sign-in. Returning undefined lets the
  // existing authorization refusal stand, which is the safe direction: no offer, no execution.
  if (!input.elevations) return undefined;

  const { elevation, continuation } = await input.elevations.request({
    sessionId: input.session.id,
    tenant: input.session.tenant,
    tool: input.tool.name,
    claimableStateHandles: claimableStateHandleNames(input.state),
    now: input.now,
  });
  return {
    event: {
      event: 'auth_requested',
      data: {
        id: elevation.id,
        tool: input.tool.name,
        signInTicket: continuation,
        continuation,
        expiresAt: elevation.expiresAt,
      },
    },
    modelResult: JSON.stringify({
      status: 'sign_in_required',
      tool: input.tool.name,
      message:
        'This needs a signed-in visitor. Ask them to sign in using the card shown, then offer to try again. Do not call this tool until they have.',
    }),
  };
}

/**
 * The elevation half of the session exchange, kept out of `assistant.ts` because it is a different
 * responsibility from minting one — and because that file is at its size limit, which is the repo's
 * way of saying a second concern has arrived.
 *
 * The caller has already authenticated the client and built the principal; what happens here is the
 * dual-key check and the response. Refusals are audited too: a client reaching for a conversation it
 * does not own is the one an operator should be able to see.
 */
export async function elevateAssistantSession(
  res: ServerResponse,
  deps: {
    readonly elevations?: AssistantElevationStore;
    readonly elevationCoordinator?: AssistantElevationCoordinator;
    readonly store: { elevateSession: AssistantStore['elevateSession'] };
    readonly audit: AuditSink;
    readonly clock?: () => Date;
  },
  input: {
    readonly signInTicket: unknown;
    readonly client: { readonly id: string; readonly tenant: TenantRef };
    /** Already allowlist-validated by the route; where the elevated conversation continues. */
    readonly origin: string;
    /** Already validated against the artifact's customerEndpoints; absent means unchanged. */
    readonly customerRouting?: AssistantSessionRecord['customerRouting'];
    /** The surface owning the elevation origin, route-computed; the conversation lands there. */
    readonly boundSurface?: AssistantSessionRecord['boundSurface'];
    readonly caller: AssistantSessionRecord['caller'];
    readonly configuration: AssistantSessionRecord['configuration'];
    readonly endpoints: Readonly<Record<string, string>>;
    /** Route-computed policy (default ON, exchange override wins): arms the one-shot resume. */
    readonly resume: boolean;
  },
): Promise<void> {
  if (typeof input.signInTicket !== 'string' || input.signInTicket.length === 0) {
    // Same recovery as a spent ticket — obtain a fresh one — so it reuses the same code; the 400
    // status preserves the malformed-vs-refused distinction for operators.
    return sendJson(res, 400, {
      error: 'signInTicket must be a non-empty string',
      code: 'elevation_ticket_invalid',
    });
  }
  if (!deps.elevations) {
    return sendJson(res, 503, {
      error: 'sign-in elevation is not available on this deployment',
      code: 'elevation_unavailable',
    });
  }
  const request = {
    continuation: input.signInTicket,
    tenant: input.client.tenant,
    caller: input.caller,
    // The elevating client, not the session's minting embed id: post-elevation delegated
    // exchanges must assert the issuer a fresh authenticated mint would (ADR 0152).
    clientId: input.client.id,
    origin: input.origin,
    ...(input.customerRouting ? { customerRouting: input.customerRouting } : {}),
    ...(input.boundSurface ? { boundSurface: input.boundSurface } : {}),
    resume: input.resume,
  } as const;
  const elevated = deps.elevationCoordinator
    ? await deps.elevationCoordinator.complete(request)
    : await completeElevation(request, {
        elevations: deps.elevations,
        elevateSession: (elevation) => deps.store.elevateSession(elevation),
        now: () => deps.clock?.() ?? new Date(),
      });
  if (!elevated.ok) {
    await deps.audit.emit({
      eventType: 'assistant.session.elevation_refused',
      org: input.client.tenant.org,
      app: input.client.tenant.app,
      env: input.client.tenant.env,
      decision: 'deny',
      reasonCode: elevated.code,
      actorSubject: input.caller.subject,
    });
    // `{ error: <human>, code: <machine> }`, the same envelope as public-session refusals: the
    // published client reads `body.code`, and a host must be able to tell "the visitor took too
    // long" from "a client reached across a tenant boundary" without string-matching prose.
    return sendJson(res, elevated.status, {
      error: ELEVATION_REFUSAL_MESSAGES[elevated.code],
      code: elevated.code,
    });
  }
  await deps.audit.emit({
    eventType: 'assistant.session.elevated',
    org: input.client.tenant.org,
    app: input.client.tenant.app,
    env: input.client.tenant.env,
    deploymentId: elevated.session.deploymentId,
    decision: 'allow',
    actorSubject: input.caller.subject,
    // What they signed in *for*: an elevation with no reason is an elevation nobody can review.
    details: { tool: elevated.tool, sessionId: elevated.session.id },
  });
  // The same wire shape a fresh exchange returns, parsed for the same reason (ADR 0151): the widget
  // cannot tell the two apart, so they must not differ.
  const body = {
    token: elevated.token,
    expiresAt: elevated.session.expiresAt,
    endpoints: input.endpoints,
    ...(input.configuration ? { configuration: input.configuration } : {}),
    // The armed hint: the widget answers with one { resume: true } turn on the turns endpoint.
    ...(elevated.resumeArmed ? { resume: { tool: elevated.tool } } : {}),
    continuedAfterAuthentication: true as const,
  };
  assistantSessionResponseSchema.parse(body);
  return sendJson(res, 200, body);
}

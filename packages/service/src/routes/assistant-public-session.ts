import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMISSION_DEFAULTS, clientAddressBucket } from '@noodle-borg/admission-limits/portable';
import {
  type AssistantAppearanceOverride,
  type AssistantSessionRecord,
  effectiveAssistantBrowserConfiguration,
  mintPublicSession,
  publicEmbedTenant,
  publicSurfaceOf,
  type SurfaceBudgetBounds,
} from '@noodle-borg/assistant-gateway/portable';
import {
  assistantSessionUsageRequestEvent,
  captureAssistantUsage,
  captureRefusedAssistantSession,
} from '@noodle-borg/observability';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { assistantSessionResponseSchema } from '@noodle-borg/wire-contracts';
import type { AssistantRouteDeps } from './assistant.js';
import { applyBrowserCors, assistantSessionEndpoints, now } from './assistant-route-http.js';

/**
 * The transport half of anonymous session minting. Every decision — which refusal, in which order, and
 * whether the surface may serve at all — lives in `@noodle-borg/assistant-gateway`; this file parses a
 * request, supplies ports, and maps the result onto HTTP.
 *
 * Unlike the authenticated exchange, which is backend-to-backend, this route is called directly by the
 * visitor's browser, so CORS is part of its contract rather than an afterthought: a successful mint
 * echoes the validated origin, and a refusal echoes nothing, so a page that is not on the allowlist
 * fails visibly instead of quietly receiving a usable token.
 */

export async function handlePublicAssistantSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<void> {
  const usageStartedAt = performance.now();
  const embeds = deps.publicEmbeds;
  const counters = deps.admissionCounters;
  if (!embeds || !counters) {
    return sendJson(res, 503, { error: 'public assistant surfaces are not enabled' });
  }
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const { embedId, visitorId } = body.value as { embedId?: unknown; visitorId?: unknown };
  // The browser's Origin header is the claim under test. The body never asserts its own origin.
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  // Admission tier 3. Hashed here so no raw address crosses into the decision, a counter key, or an
  // audit payload; the socket address is Google's front end on Cloud Run, so the forwarded chain is the
  // only place the visitor appears. Unparseable ingress yields no bucket and the surface tier alone
  // applies — losing fairness, never solvency.
  const addressBucket = clientAddressBucket(
    typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
  );

  let configuration: AssistantAppearanceOverride | undefined;
  let sponsoredBudget: SurfaceBudgetBounds | undefined;
  let usageSession: AssistantSessionRecord | undefined;
  const result = await mintPublicSession(
    { embedId, visitorId, origin, ...(addressBucket ? { addressBucket } : {}) },
    deps.admissionEnvelope ?? ADMISSION_DEFAULTS,
    {
      embeds,
      counters,
      resolveActiveSurface: async (embed) => {
        const target = await deps.registry.getActiveByTenant(publicEmbedTenant(embed));
        if (!target?.deploymentId) return undefined;
        if (target.served.artifact.server.assistant?.model.kind === 'noodle-managed') {
          sponsoredBudget = (
            await deps.managedModelResolver?.resolve({
              tenant: publicEmbedTenant(embed),
              deploymentId: target.deploymentId,
            })
          )?.publicAdmission;
        }
        // Read from the ACTIVE deployment rather than cached on the embed record — which is what lets
        // `noodle deploy` alone update a snippet a customer pasted months ago.
        return publicSurfaceOf(target.served.artifact.server.assistant);
      },
      resolveBudgetBounds: async () => sponsoredBudget,
      createSession: async (input) => {
        const target = await deps.registry.getActiveByTenant(publicEmbedTenant(input.embed));
        if (!target?.deploymentId) throw new Error('assistant deployment vanished mid-mint');
        const current = now(deps);
        configuration = (
          await effectiveAssistantBrowserConfiguration(
            target.served.artifact.server,
            publicEmbedTenant(input.embed),
            deps.appearance,
            'public',
          )
        ).effective;
        const created = await deps.store.createSession({
          // A public surface has no client credential, so the embed id stands in as the minting
          // authority. It is not a secret and nothing downstream may begin treating it as one.
          clientId: input.embed.embedId,
          tenant: publicEmbedTenant(input.embed),
          deploymentId: target.deploymentId,
          modelSource:
            target.served.artifact.server.assistant?.model.kind === 'noodle-managed'
              ? 'noodle-managed'
              : 'operator',
          origin: input.origin,
          publicEmbedId: input.embed.embedId,
          boundSurface: 'public',
          caller: { subject: input.subject, identityKind: 'anonymous' },
          ...(configuration ? { configuration } : {}),
          createdAt: current.toISOString(),
          expiresAt: new Date(current.getTime() + input.envelope.sessionIdleMs).toISOString(),
          absoluteExpiresAt: new Date(
            current.getTime() + input.envelope.sessionAbsoluteMs,
          ).toISOString(),
        });
        usageSession = created.session;
        return { token: created.token, expiresAt: created.session.expiresAt };
      },
      // Opaque, server-minted, unlinkable to any person: nothing from the request becomes a subject.
      newAnonymousSubject: () => `anon_${randomBytes(24).toString('base64url')}`,
      now: () => now(deps),
    },
  );

  if (!result.ok) {
    // A refusal the surface owns is usage. Without it an operator whose visitors are being turned
    // away sees a healthy-looking page; which refusals count is the helper's decision, not this one's.
    const refusedIn = performance.now() - usageStartedAt;
    captureRefusedAssistantSession(deps.captureRequestEvent, result, refusedIn);
    return sendJson(res, result.status, { error: result.message, code: result.code });
  }
  // Only here, with the origin proven against the live surface, may the page read the response.
  applyBrowserCors(req, res, origin);
  const sessionBody = {
    token: result.token,
    expiresAt: result.expiresAt,
    endpoints: assistantSessionEndpoints(deps.serviceBase(req)),
    ...(configuration ? { configuration } : {}),
  };
  // Parse rather than trust: every published @noodleseed/assistant widget consumes this shape, and the
  // public mint must not be the path that quietly diverges from it (ADR 0151).
  assistantSessionResponseSchema.parse(sessionBody);
  if (usageSession !== undefined) {
    captureAssistantUsage(
      deps.captureRequestEvent,
      assistantSessionUsageRequestEvent(usageSession, performance.now() - usageStartedAt),
    );
  }
  return sendJson(res, 201, sessionBody);
}

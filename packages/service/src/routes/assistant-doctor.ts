import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { probeAssistantModelBoundary } from '@noodle-borg/assistant-gateway/model-runtime';
import {
  assistantCustomerIssuer,
  completeElevation,
  publicSurfaceOf,
} from '@noodle-borg/assistant-gateway/portable';
import { guardedFetch } from '@noodle-borg/connector-http';
import { tenantMcpUrl } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { TenantRef } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';
import { resolveAssistantModelBinding } from './assistant-model-binding.js';
import { now } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';
import { authorizeControlPlane } from './control-plane.js';

/**
 * The doctor half of the assistant boundary, kept out of `assistant.ts` for the same reason the
 * elevation half is: a different responsibility, and that file is at its size limit.
 */

/** Validate the customer backend ↔ active embedded-assistant boundary without invoking a tool. */
export async function handleAssistantDoctor(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  deps: AssistantRouteDeps,
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: false });
  if (identity === false) return;
  if (identity && !identity.superAdmin) {
    const member = await deps.controlPlane.isOrgMember({
      org: tenant.org,
      subject: identity.subject,
    });
    if (!member) return sendForbidden(res, 'forbidden');
  }
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  if (!isRecord(body.value)) return sendJson(res, 400, { error: 'invalid doctor request' });
  const { clientId, clientSecret, origin, userId } = body.value;
  if (
    typeof clientId !== 'string' ||
    clientId.length < 1 ||
    typeof clientSecret !== 'string' ||
    clientSecret.length < 1 ||
    typeof origin !== 'string' ||
    origin.length < 1 ||
    (userId !== undefined &&
      (typeof userId !== 'string' || userId.length < 1 || userId.length > 240))
  ) {
    return sendJson(res, 400, { error: 'clientId, clientSecret, and origin are required' });
  }

  const target = await activeAssistantTarget({ registry: deps.registry }, tenant);
  const assistant = target?.served.artifact.server.assistant;
  const deploymentOk = Boolean(target?.deploymentId && assistant);
  const client = await deps.store.authenticateClient(clientId, clientSecret);
  const clientOk = client !== undefined && sameTenant(client.tenant, tenant);
  const originOk = assistant?.allowedOrigins.includes(origin) === true;
  const model = await probeAssistantModelBoundary({
    ready: deploymentOk && clientOk && originOk,
    resolveBinding: async () =>
      target?.deploymentId
        ? resolveAssistantModelBinding(target, tenant, target.deploymentId, deps)
        : undefined,
    fetcher: deps.modelFetch ?? ((url, init) => guardedFetch(new URL(url), init)),
    onFailure: (result, binding) =>
      deps.logger?.warn('assistant.model_probe.failed', {
        ...tenant,
        ...(target?.deploymentId ? { deploymentId: target.deploymentId } : {}),
        transport: result.transport,
        modelSource: binding?.source ?? 'operator',
        code: result.code,
        ...(result.status === undefined ? {} : { status: result.status }),
        retryable: result.retryable,
      }),
  });
  let delegatedCredentials:
    | { readonly ok: boolean; readonly probes: readonly unknown[] }
    | { readonly ok: false; readonly skipped: true; readonly reason: string };
  if (!deploymentOk || !clientOk || !originOk || !target || !client) {
    delegatedCredentials = {
      ok: false,
      skipped: true,
      reason: 'deployment, client, and origin checks must pass first',
    };
  } else if (target.served.deps.broker.probeDelegatedCredentials === undefined) {
    delegatedCredentials = {
      ok: false,
      skipped: true,
      reason: 'deployment credential broker does not support diagnostics',
    };
  } else {
    const probes = await target.served.deps.broker.probeDelegatedCredentials(
      {
        subject: typeof userId === 'string' ? userId : 'noodle-assistant-doctor',
        identityKind: 'customer',
        audience: tenantMcpUrl(deps.serviceBase(req), tenant),
      },
      undefined,
      assistantCustomerIssuer(client.id),
    );
    delegatedCredentials = { ok: probes.every((probe) => probe.ok), probes };
  }
  // Synthetic sign-in round trip (ADR 0201, 5.6b): issue -> claim -> elevate against a throwaway
  // anonymous session, the same code path a real sign-in takes — including the clientId (issuer
  // basis, ADR 0152) and origin rebind. Without this, doctor certified the authenticated exchange
  // while the sign-in leg could be broken or unconfigured. The ticket is spent inside the probe and
  // never leaves this handler; the throwaway session expires on its own.
  let elevation:
    | { readonly ok: boolean; readonly skipped?: true; readonly reason?: string }
    | { readonly ok: true; readonly issuerRebound: true };
  const signInSurface = publicSurfaceOf(assistant)?.mode === 'mixed';
  if (!deploymentOk || !clientOk || !originOk || !target || !client) {
    elevation = {
      ok: false,
      skipped: true,
      reason: 'deployment, client, and origin checks must pass first',
    };
  } else if (!signInSurface) {
    elevation = { ok: true, skipped: true, reason: 'no mixed surface declares sign-in' };
  } else if (!deps.elevations) {
    elevation = {
      ok: false,
      reason: 'a mixed surface promises sign-in, but no elevation store is configured',
    };
  } else {
    const current = now(deps);
    const probeSession = await deps.store.createSession({
      clientId: client.id,
      tenant: client.tenant,
      deploymentId: target.deploymentId ?? '',
      origin,
      caller: { subject: `noodle-doctor-anon-${randomUUID()}`, identityKind: 'anonymous' },
      createdAt: current.toISOString(),
      expiresAt: new Date(current.getTime() + 60_000).toISOString(),
      absoluteExpiresAt: new Date(current.getTime() + 60_000).toISOString(),
    });
    const { continuation } = await deps.elevations.request({
      sessionId: probeSession.session.id,
      tenant: client.tenant,
      tool: 'noodle_assistant_doctor',
      now: current,
    });
    const elevated = await completeElevation(
      {
        continuation,
        tenant: client.tenant,
        caller: {
          subject: typeof userId === 'string' ? userId : 'noodle-assistant-doctor',
          identityKind: 'customer',
          audience: tenantMcpUrl(deps.serviceBase(req), tenant),
        },
        clientId: client.id,
        origin,
      },
      {
        elevations: deps.elevations,
        elevateSession: (request) => deps.store.elevateSession(request),
        now: () => now(deps),
      },
    );
    elevation =
      elevated.ok && elevated.session.clientId === client.id && elevated.session.origin === origin
        ? { ok: true, issuerRebound: true }
        : {
            ok: false,
            reason: elevated.ok ? 'elevation did not rebind the session' : elevated.code,
          };
  }
  const checks = {
    deployment: {
      ok: deploymentOk,
      ...(target?.deploymentId ? { deploymentId: target.deploymentId } : {}),
    },
    client: {
      ok: clientOk,
      ...(clientOk && client ? { createdAgainstDeploymentId: client.deploymentId } : {}),
    },
    origin: {
      ok: originOk,
      origin,
      ...(assistant ? { allowedOrigins: assistant.allowedOrigins } : {}),
    },
    model,
    elevation,
    delegatedCredentials,
  };
  return sendJson(res, 200, {
    ok: Object.values(checks).every((check) => check.ok),
    ...(target?.deploymentId ? { deploymentId: target.deploymentId } : {}),
    checks,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameTenant(a: TenantRef, b: TenantRef): boolean {
  return a.org === b.org && a.app === b.app && a.env === b.env;
}

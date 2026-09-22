import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChannelError,
  type ChannelEvent,
  channelParticipantId,
  recordChannelDelivery,
} from '@noodle-borg/assistant-gateway/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import * as wire from '@noodle-borg/wire-contracts';
import type { z } from 'zod';
import {
  parseWhatsAppWebhook,
  verifyWhatsAppWebhookSecret,
  WHATSAPP_CALLBACK_HEADER,
} from '../channels/360dialog.js';
import { WHATSAPP_META_CALLBACK_PATH } from '../channels/meta-cloud.js';
import type { WhatsAppRuntime } from '../channels/runtime.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';
import { metaWebhook } from './whatsapp-meta.js';

const participant = /^p_[a-f0-9]{64}$/;
const eventId = /^e_[0-9_]+$/;
function eventView(event: ChannelEvent) {
  return {
    id: event.id,
    participantId: event.participantId,
    state: event.state,
    eventAt: event.eventAt,
    receivedAt: event.receivedAt,
    attempts: event.attempts,
    deploymentId: event.deploymentId,
    ...(event.code ? { code: event.code } : {}),
  };
}
function respond(res: ServerResponse, schema: { parse(value: unknown): unknown }, data: unknown) {
  sendJson(res, 200, schema.parse({ ok: true, data }));
}
async function body<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const input = await readJsonBody(req, 16_384);
  if (!input.ok) throw new ChannelError('request_invalid');
  const parsed = schema.safeParse(input.value);
  if (!parsed.success) throw new ChannelError('request_invalid');
  return parsed.data;
}
export function dispatchWhatsAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: WhatsAppRuntime | undefined,
  grants?: DeveloperGrantStore,
): boolean {
  const callback = /^\/v1\/channels\/whatsapp\/webhooks\/([a-z0-9-]+)$/.exec(url.pathname);
  const operator =
    /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/channels\/whatsapp(?:\/(.*))?$/.exec(
      url.pathname,
    );
  const meta = url.pathname === WHATSAPP_META_CALLBACK_PATH;
  if (!callback && !operator && !meta) return false;
  res.setHeader('Cache-Control', 'no-store');
  if (!runtime) {
    sendJson(res, 503, {
      error: 'WhatsApp is unavailable on this service',
      code: 'whatsapp_unavailable',
    });
    return true;
  }
  const run = Promise.resolve().then(() =>
    meta
      ? metaWebhook(req, res, url, runtime)
      : callback
        ? webhook(req, res, callback[1]!, runtime)
        : operate(
            req,
            res,
            url,
            {
              org: decodeURIComponent(operator![1]!),
              app: decodeURIComponent(operator![2]!),
              env: decodeURIComponent(operator![3]!),
            },
            operator![4] ?? '',
            runtime,
            grants,
          ),
  );
  void run.catch((error) => {
    const code = error instanceof ChannelError ? error.code : 'channel_unavailable';
    const status =
      code === 'channel_not_found'
        ? 404
        : [
              'revision_conflict',
              'idempotency_conflict',
              'asset_in_use',
              'not_ready',
              'deployment_changed',
            ].includes(code)
          ? 409
          : code === 'channel_unavailable' || code === 'ingress_capacity'
            ? 503
            : 400;
    if (!res.headersSent) sendJson(res, status, { error: code, code });
  });
  return true;
}
async function webhook(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  runtime: WhatsAppRuntime,
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  const binding = await runtime.channels.internal(id);
  // Meta numbers share the signed app callback; only 360dialog has a per-binding address.
  if (binding.provider !== '360dialog') return sendJson(res, 404, { error: 'not_found' });
  const { webhookSecret } = await runtime.provider(binding);
  if (
    !webhookSecret ||
    !verifyWhatsAppWebhookSecret(req.headers[WHATSAPP_CALLBACK_HEADER], webhookSecret)
  )
    return sendJson(res, 401, { error: 'unauthorized' });
  const input = await readJsonBody(req, 1 << 20);
  if (!input.ok) return sendJson(res, input.status, { error: 'webhook_invalid' });
  const batch = parseWhatsAppWebhook(input.value, binding.phoneNumberId);
  await runtime.channels.receive(id, batch.messages, await runtime.retention(binding));
  for (const status of batch.statuses)
    await recordChannelDelivery(
      runtime.channels.store,
      id,
      status.providerMessageId,
      status.state,
      runtime.channels.now(),
    );
  sendJson(res, 200, { ok: true });
  runtime.options.worker.wake();
}
async function operate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  tenant: TenantRef,
  path: string,
  runtime: WhatsAppRuntime,
  grants?: DeveloperGrantStore,
): Promise<void> {
  const { deps, channels } = runtime;
  const read = req.method === 'GET';
  const identity = await authorizeTenantControl(
    req,
    res,
    deps.gate,
    deps.controlPlane,
    tenant.org,
    developerGrantRouteAccess(grants, read ? 'cloud:read' : 'config:write'),
  );
  if (identity === false) return;
  const member = await deps.controlPlane.getOrgMember({
    org: tenant.org,
    subject: identity.subject,
  });
  if (!read && !identity.superAdmin && member?.role !== 'owner' && member?.role !== 'developer')
    return sendJson(res, 403, { error: 'operator_required' });
  const key = req.headers['idempotency-key'];
  if (!read && (typeof key !== 'string' || !key || key.length > 200))
    throw new ChannelError('idempotency_key_invalid');
  const idempotency = typeof key === 'string' ? key : '';
  const visible = await channels.get(tenant);
  const audit = async (action: string) =>
    deps.audit.emit({
      eventType: `assistant.channel.${action}`,
      ...tenant,
      actorSubject: identity.subject,
      decision: 'allow',
      status: 200,
    });
  if (!path && req.method === 'GET')
    return respond(res, wire.WhatsAppBindingResponseSchema, visible ?? null);
  if (!path && req.method === 'PUT') {
    const parsed = await body(req, wire.WhatsAppConfigureRequestSchema);
    const target = await deps.registry.getActiveByTenant(tenant);
    if (!target?.deploymentId) throw new ChannelError('deployment_missing');
    const { expectedRevision, ...configuration } = parsed;
    const configured = await channels.configure(
      { ...configuration, tenant, deploymentId: target.deploymentId },
      identity.subject,
      idempotency,
      expectedRevision,
    );
    await audit('configured');
    return respond(res, wire.WhatsAppBindingResponseSchema, configured);
  }
  if (!visible) throw new ChannelError('channel_not_found');
  const id = visible.id;
  if (path === 'readiness' && req.method === 'POST') {
    await body(req, wire.WhatsAppEmptyRequestSchema);
    return respond(res, wire.WhatsAppReadinessResponseSchema, await runtime.doctor(id, req));
  }
  if ((path === 'state' && req.method === 'PATCH') || (!path && req.method === 'DELETE')) {
    const parsed = path
      ? await body(req, wire.WhatsAppStateRequestSchema)
      : {
          ...(await body(req, wire.WhatsAppRevisionRequestSchema)),
          state: 'disconnected' as const,
        };
    const updated = await channels.setState(
      id,
      parsed.state,
      identity.subject,
      idempotency,
      parsed.expectedRevision,
    );
    await audit(parsed.state);
    return respond(res, wire.WhatsAppBindingResponseSchema, updated);
  }
  if (path === 'limits' && req.method === 'GET')
    return respond(res, wire.WhatsAppBindingResponseSchema, visible);
  if (path === 'limits' && req.method === 'PATCH') {
    const parsed = await body(req, wire.WhatsAppLimitsRequestSchema);
    const updated = await channels.updateLimits(
      id,
      parsed.limits,
      identity.subject,
      idempotency,
      parsed.expectedRevision,
    );
    await audit('limits_changed');
    return respond(res, wire.WhatsAppBindingResponseSchema, updated);
  }
  if (path === 'usage' && read)
    return respond(res, wire.WhatsAppUsageResponseSchema, await channels.usage(id));
  if (path === 'webhook' && (read || req.method === 'POST')) {
    if (!read) {
      const parsed = await body(req, wire.WhatsAppRevisionRequestSchema);
      if (parsed.expectedRevision !== visible.revision) throw new ChannelError('revision_conflict');
      await runtime.configureWebhook(id, req);
      await audit('webhook_configured');
    }
    return respond(res, wire.WhatsAppWebhookResponseSchema, await runtime.webhook(id, req));
  }
  if (path === 'blocks' && read) {
    const after = url.searchParams.get('after') ?? undefined;
    if (after && !participant.test(after)) throw new ChannelError('request_invalid');
    return sendJson(
      res,
      200,
      wire.WhatsAppBlocksResponseSchema.parse({ ok: true, ...(await runtime.blocks(id, after)) }),
    );
  }
  if (path === 'blocks' && req.method === 'POST') {
    const parsed = await body(req, wire.WhatsAppBlockRequestSchema);
    const participantId =
      parsed.participantId ??
      channelParticipantId(await channels.internal(id), {
        kind: 'phone',
        value: parsed.phone!.slice(1),
      });
    await channels.block(id, participantId, identity.subject, idempotency, parsed.until);
    if (parsed.scope === 'provider')
      await runtime.providerBlock(id, participantId, true, identity.subject, idempotency);
    await audit('blocked');
    return sendJson(res, 200, wire.WhatsAppMutationResponseSchema.parse({ ok: true }));
  }
  const [kind, value, action] = path.split('/');
  if (kind === 'blocks' && value && participant.test(value) && req.method === 'DELETE') {
    const parsed = await body(req, wire.WhatsAppUnblockRequestSchema);
    if (parsed.scope === 'provider')
      await runtime.providerBlock(id, value, false, identity.subject, idempotency, parsed.phone);
    else await channels.unblock(id, value, identity.subject, idempotency);
    await audit('unblocked');
    return sendJson(res, 200, { ok: true });
  }
  if (
    kind === 'cooldowns' &&
    value &&
    participant.test(value) &&
    (read || req.method === 'DELETE')
  ) {
    if (!read) {
      await body(req, wire.WhatsAppEmptyRequestSchema);
      await channels.clearCooldown(id, value, identity.subject, idempotency);
      await audit('cooldown_cleared');
    }
    return respond(res, wire.WhatsAppCooldownResponseSchema, await channels.cooldown(id, value));
  }
  if (
    kind === 'participants' &&
    value &&
    participant.test(value) &&
    action === 'forget' &&
    req.method === 'POST'
  ) {
    await body(req, wire.WhatsAppEmptyRequestSchema);
    await channels.forget(id, value, identity.subject, idempotency);
    await audit('conversation_forgotten');
    return sendJson(res, 200, { ok: true });
  }
  if (
    kind === 'events' &&
    (!value || eventId.test(value)) &&
    (read || (action === 'reconcile' && req.method === 'POST'))
  ) {
    if (!read) {
      await body(req, wire.WhatsAppEmptyRequestSchema);
      await audit('receipt_inspected');
    }
    if (value) {
      const event = await channels.event(id, value);
      if (!event) throw new ChannelError('event_not_found');
      return respond(res, wire.WhatsAppEventsResponseSchema, [eventView(event)]);
    }
    const after = url.searchParams.get('after') ?? undefined;
    if (after && !eventId.test(after)) throw new ChannelError('cursor_invalid');
    const events = await channels.events(id, after);
    return sendJson(
      res,
      200,
      wire.WhatsAppEventsResponseSchema.parse({
        ok: true,
        data: events.map(eventView),
        ...(events.length === 100 ? { next: events.at(-1)!.id } : {}),
      }),
    );
  }
  sendJson(res, 404, { error: 'not_found' });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ADMISSION_DEFAULTS, clamp } from '@noodle-borg/admission-limits/portable';
import {
  type AssistantEmbedOperatorView,
  assistantEmbedOperatorView,
  parsePublicEmbedBudget,
  publicSurfaceOf,
  surfaceEnvelope,
} from '@noodle-borg/assistant-gateway/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { TenantRef } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';
import { now } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';
import { authorizeControlPlane } from './control-plane.js';

/**
 * The operator's view of a tenant's public surfaces, and the one control over them.
 *
 * `PATCH` sets the daily caps; `--turns-per-day 0` is the kill switch, and it is deliberately the only
 * documented one. Revoking an embed would also stop a surface, but it destroys the paste-once id and
 * every page carrying it, so it stays an exceptional action rather than the routine off-switch.
 *
 * Origins, capabilities, and surfaceMode are read from the *active* deployment rather than the embed
 * row, so what an operator sees here is what a browser will actually be held to at mint time (the row
 * keeps its provisioning-time mode by design — `ensure` never overwrites a live row).
 */

export async function handleAssistantEmbeds(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  embedId: string | undefined,
  deps: AssistantRouteDeps,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: false });
  if (identity === false) return;
  if (identity && !identity.superAdmin) {
    const member = await deps.controlPlane.isOrgMember({
      org: tenant.org,
      subject: identity.subject,
    });
    if (!member) return sendForbidden(res, 'forbidden');
  }

  const embeds = deps.publicEmbeds;
  const counters = deps.admissionCounters;
  if (!embeds || !counters) {
    return sendJson(res, 503, { error: 'public assistant surfaces are not enabled' });
  }
  const defaults = deps.admissionEnvelope ?? ADMISSION_DEFAULTS;

  if (embedId === undefined && req.method === 'GET') {
    const records = await embeds.list(tenant);
    const views = await Promise.all(
      records.map((record) => view(record, tenant, defaults, deps, counters)),
    );
    return sendJson(res, 200, { ok: true, embeds: views });
  }

  if (embedId !== undefined && req.method === 'PATCH') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const budget = parsePublicEmbedBudget(body.value);
    if (!budget.ok) return sendJson(res, 400, { error: budget.error });

    const owned = (await embeds.list(tenant)).some(
      (record) => record.embedId === embedId && record.revokedAt === undefined,
    );
    if (!owned) return sendJson(res, 404, { error: 'embed not found' });

    const updated = await embeds.setBudget(embedId, budget.value, now(deps));
    // 404 here rather than the mint route's 403: this caller has already proven org membership, so
    // telling them an id of theirs does not exist is information they are entitled to.
    if (!updated) return sendJson(res, 404, { error: 'embed not found' });
    return sendJson(res, 200, {
      ok: true,
      embed: await view(updated, tenant, defaults, deps, counters),
    });
  }

  res.setHeader('Allow', embedId === undefined ? 'GET' : 'PATCH');
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function view(
  record: Awaited<ReturnType<NonNullable<AssistantRouteDeps['publicEmbeds']>['ensure']>>,
  tenant: TenantRef,
  defaults: typeof ADMISSION_DEFAULTS,
  deps: AssistantRouteDeps,
  counters: NonNullable<AssistantRouteDeps['admissionCounters']>,
): Promise<AssistantEmbedOperatorView> {
  const target = await activeAssistantTarget({ registry: deps.registry }, tenant);
  const at = now(deps);
  // The same bounds admission resolves, not the bare defaults: a sponsored surface enforces the
  // hosted envelope, and reporting the unsponsored one told an operator a number nothing honours.
  const deploymentId = target?.deploymentId ?? '';
  const bounds =
    target?.served.artifact.server.assistant?.model?.kind === 'noodle-managed'
      ? (await deps.managedModelResolver?.resolve({ tenant, deploymentId }))?.publicAdmission
      : undefined;
  return assistantEmbedOperatorView({
    record,
    surface: publicSurfaceOf(target?.served.artifact.server.assistant),
    // Clamped even for the pure-default case, so what an operator reads is what admission enforces.
    envelope: surfaceEnvelope(clamp(defaults), record, bounds),
    peek: (key) => counters.peek(key, at),
    ...(bounds?.spend === undefined ? {} : { spend: bounds.spend }),
  });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type AssistantAppearanceOverride,
  type AssistantAppearanceSettingsRecord,
  assistantAppearanceOverrideSchema,
  assistantBrowserConfiguration,
  resolveAssistantAppearanceConfiguration,
} from '@noodle-borg/assistant-gateway/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { TenantRef } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';
import { now } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';
import { authorizeControlPlane } from './control-plane.js';

export async function handleAssistantAppearance(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  deps: AssistantRouteDeps,
): Promise<void> {
  const store = deps.appearance;
  if (store === undefined)
    return sendJson(res, 503, { error: 'assistant appearance is unavailable' });
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: false });
  if (identity === false) return;
  if (identity && !identity.superAdmin) {
    const member = await deps.controlPlane.isOrgMember({
      org: tenant.org,
      subject: identity.subject,
    });
    if (!member) return sendForbidden(res, 'forbidden');
  }

  if (req.method === 'GET') return respond(res, tenant, deps);
  const expectedRevision = parseExpectedRevision(req.headers['if-match']);
  if (expectedRevision === undefined) {
    return sendJson(res, req.headers['if-match'] === undefined ? 428 : 400, {
      error: req.headers['if-match'] === undefined ? 'If-Match is required' : 'invalid If-Match',
    });
  }

  let override: AssistantAppearanceOverride | undefined;
  if (req.method === 'PUT') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = assistantAppearanceOverrideSchema.safeParse(body.value);
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid assistant appearance' });
    override = parsed.data;
  } else if (req.method !== 'DELETE') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const updated = await store.replace({
    tenant,
    expectedRevision,
    override,
    updatedAt: now(deps),
    updatedBy: identity?.subject ?? 'local-operator',
  });
  if (!updated.ok) {
    return sendJson(res, 409, {
      error: 'assistant appearance revision conflict',
      currentRevision: updated.currentRevision,
    });
  }
  const target = await activeAssistantTarget({ registry: deps.registry }, tenant);
  await deps.audit.emit({
    eventType:
      updated.record.override === undefined
        ? 'assistant.appearance.reset'
        : 'assistant.appearance.updated',
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    ...(target?.deploymentId ? { deploymentId: target.deploymentId } : {}),
    decision: 'allow',
    status: 200,
    ...(identity ? { actorSubject: identity.subject } : {}),
    ...(identity?.email ? { actorEmail: identity.email } : {}),
    details: {
      revision: updated.record.revision,
      hasOverride: updated.record.override !== undefined,
    },
  });
  return respond(res, tenant, deps, updated.record, target);
}

async function respond(
  res: ServerResponse,
  tenant: TenantRef,
  deps: AssistantRouteDeps,
  knownRecord?: AssistantAppearanceSettingsRecord,
  knownTarget?: Awaited<ReturnType<AssistantRouteDeps['registry']['getActiveByTenant']>>,
): Promise<void> {
  const target = knownTarget ?? (await activeAssistantTarget({ registry: deps.registry }, tenant));
  const developer = target && assistantBrowserConfiguration(target.served.artifact.server);
  const record = knownRecord ?? (await deps.appearance?.get(tenant));
  const resolution = resolveAssistantAppearanceConfiguration(developer, record?.override);
  const revision = record?.revision ?? 0;
  res.setHeader('etag', `"${revision}"`);
  return sendJson(res, 200, {
    ok: true,
    assistantEnabled: target?.served.artifact.server.assistant !== undefined,
    revision,
    fallback: resolution.fallback,
    developer: developer ?? null,
    override: record?.override ?? null,
    effective: resolution.effective ?? null,
    provenance: resolution.provenance,
    ...(record ? { updatedAt: record.updatedAt.toISOString(), updatedBy: record.updatedBy } : {}),
  });
}

function parseExpectedRevision(value: string | readonly string[] | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^"(0|[1-9][0-9]*)"$/.exec(value);
  if (!match?.[1]) return undefined;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : undefined;
}

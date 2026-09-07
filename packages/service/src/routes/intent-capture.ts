import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { IntentEvent, IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import type { IntentCaptureSettingsStore } from '@noodle-borg/observability';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeControlPlane, authorizeTenantControl } from './control-plane.js';
import { canManageMembers } from './org-admin.js';

const RETENTION_DAYS = 14;
const SCAN_LIMIT = 50_000;
const RECENT_LIMIT = 100;
const WINDOWS_MS = new Map([
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['14d', RETENTION_DAYS * 24 * 60 * 60 * 1000],
]);

export interface IntentCaptureRouteDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly settings: IntentCaptureSettingsStore;
  readonly intents: IntentEventStore;
  readonly requests: RequestEventStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly previewOrgs: ReadonlySet<string>;
  readonly clock?: () => Date;
}

export async function handleIntentCaptureSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  deps: IntentCaptureRouteDeps,
): Promise<void> {
  if (req.method === 'GET') {
    const identity = await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, ref.org);
    if (identity === false) return;
    if (!deps.previewOrgs.has(ref.org)) {
      return sendJson(res, 403, { ok: false, error: 'intent capture preview is unavailable' });
    }
    const setting = await deps.settings.get(ref);
    return sendJson(res, 200, {
      ok: true,
      data: {
        mode: setting?.mode ?? 'off',
        retentionDays: RETENTION_DAYS,
        taxonomy: 'starter-v1',
        ...(setting?.updatedAt === undefined ? {} : { updatedAt: setting.updatedAt }),
      },
    });
  }

  if (req.method === 'PUT') {
    const identity = await authorizeOwner(req, res, ref, deps);
    if (identity === undefined) return;
    if (!deps.previewOrgs.has(ref.org)) {
      return sendJson(res, 403, { ok: false, error: 'intent capture preview is unavailable' });
    }
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const mode = (body.value as { mode?: unknown } | null)?.mode;
    if (mode !== 'starter-v1' && mode !== 'off') {
      return sendJson(res, 400, { error: '"mode" must be starter-v1 or off' });
    }
    let setting: Awaited<ReturnType<IntentCaptureSettingsStore['set']>> | undefined;
    if (mode === 'off') {
      await deps.settings.delete(ref);
    } else {
      setting = await deps.settings.set(ref, mode, identity.subject);
    }
    await deps.audit.emit({
      eventType: mode === 'off' ? 'intent_capture.disabled' : 'intent_capture.enabled',
      org: ref.org,
      app: ref.app,
      env: ref.env,
      decision: 'allow',
      status: 200,
      actorSubject: identity.subject,
      ...(identity.email === undefined ? {} : { actorEmail: identity.email }),
      details: { mode },
    });
    return sendJson(res, 200, {
      ok: true,
      data: {
        mode,
        retentionDays: RETENTION_DAYS,
        taxonomy: 'starter-v1',
        ...(setting?.updatedAt === undefined ? {} : { updatedAt: setting.updatedAt }),
      },
    });
  }

  if (req.method === 'DELETE') {
    const identity = await authorizeOwner(req, res, ref, deps);
    if (identity === undefined) return;
    if (!deps.previewOrgs.has(ref.org)) {
      return sendJson(res, 403, { ok: false, error: 'intent capture preview is unavailable' });
    }
    await deps.settings.delete(ref);
    const purged = await deps.intents.purge(ref);
    await deps.audit.emit({
      eventType: 'intent_capture.purged',
      org: ref.org,
      app: ref.app,
      env: ref.env,
      decision: 'allow',
      status: 200,
      actorSubject: identity.subject,
      ...(identity.email === undefined ? {} : { actorEmail: identity.email }),
      details: { purged },
    });
    return sendJson(res, 200, { ok: true, data: { mode: 'off', purged } });
  }

  return sendJson(res, 405, { error: 'method not allowed' });
}

export async function handleIntentInsights(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  url: URL,
  deps: IntentCaptureRouteDeps,
): Promise<void> {
  const identity = await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, ref.org);
  if (identity === false) return;
  if (!deps.previewOrgs.has(ref.org)) {
    return sendJson(res, 403, { ok: false, error: 'intent capture preview is unavailable' });
  }
  const windowName = url.searchParams.get('window') ?? '7d';
  const windowMs = WINDOWS_MS.get(windowName);
  if (windowMs === undefined) {
    return sendJson(res, 400, { error: '"window" must be one of 24h, 7d, 14d' });
  }
  const since = new Date((deps.clock?.() ?? new Date()).getTime() - windowMs).toISOString();
  const [setting, intents, requests] = await Promise.all([
    deps.settings.get(ref),
    deps.intents.list({ ...ref, since, limit: SCAN_LIMIT }),
    deps.requests.list({ ...ref, since, limit: SCAN_LIMIT }),
  ]);
  const toolCalls = requests.filter(
    (event) => event.method === 'tools/call' && event.kind === 'usage',
  );
  const truncated = intents.length >= SCAN_LIMIT || requests.length >= SCAN_LIMIT;
  return sendJson(res, 200, {
    ok: true,
    data: {
      mode: setting?.mode ?? 'off',
      window: { name: windowName, since },
      evidence: {
        source: 'model-supplied tool schema field',
        retentionDays: RETENTION_DAYS,
        caveat: 'Coverage depends on client model support and is not guaranteed.',
      },
      coverage: {
        captured: intents.length,
        toolCalls: toolCalls.length,
        rate: toolCalls.length === 0 ? 0 : intents.length / toolCalls.length,
      },
      byCategory: counts(intents, (event) => event.category),
      byMatch: counts(intents, (event) => event.match),
      byTool: counts(intents, (event) => event.toolName),
      recent: intents.slice(0, RECENT_LIMIT),
      ...(truncated ? { truncated: true } : {}),
    },
  });
}

function counts(
  events: readonly IntentEvent[],
  key: (event: IntentEvent) => string,
): readonly { key: string; count: number }[] {
  const result = new Map<string, number>();
  for (const event of events) result.set(key(event), (result.get(key(event)) ?? 0) + 1);
  return [...result]
    .map(([name, count]) => ({ key: name, count }))
    .sort((a, b) => b.count - a.count);
}

async function authorizeOwner(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  deps: IntentCaptureRouteDeps,
): Promise<{ subject: string; email?: string } | undefined> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return undefined;
  if (!(await canManageMembers(deps.controlPlane, ref.org, identity))) {
    sendForbidden(res, 'forbidden');
    return undefined;
  }
  return identity;
}

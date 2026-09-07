import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { RequestEventStore } from '@noodle-borg/module';
import { ASSISTANT_USAGE_METHOD, aggregateAssistantUsage } from '@noodle-borg/observability';
import { sendJson } from '@noodle-borg/transport-http';
import { normalizedTimestamps } from '../http-util.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

const WINDOWS_MS = new Map<string, number>([
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
]);

/** Bounded raw-event scan; a filled scan is explicitly marked partial in the response. */
const ASSISTANT_USAGE_SCAN_LIMIT = 50_000;

export async function handleTenantAssistantUsage(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  events: RequestEventStore,
  ref: TenantRef,
  url: URL,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const identity = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (identity === false) return;

  const windowParam = url.searchParams.get('window') ?? '7d';
  const windowMs = WINDOWS_MS.get(windowParam);
  if (windowMs === undefined) {
    return sendJson(res, 400, { error: '"window" must be one of 24h, 7d, 30d' });
  }
  const timestamps = normalizedTimestamps(res, {
    until: url.searchParams.get('until') ?? undefined,
  });
  if (timestamps === undefined) return;
  const since = new Date(Date.now() - windowMs).toISOString();
  const window = await events.list({
    org: ref.org,
    app: ref.app,
    env: ref.env,
    method: ASSISTANT_USAGE_METHOD,
    since,
    ...(timestamps.until === undefined ? {} : { until: timestamps.until }),
    limit: ASSISTANT_USAGE_SCAN_LIMIT,
  });
  return sendJson(res, 200, {
    ok: true,
    window: { since, ...(timestamps.until === undefined ? {} : { until: timestamps.until }) },
    ...(window.length >= ASSISTANT_USAGE_SCAN_LIMIT ? { truncated: true } : {}),
    metrics: aggregateAssistantUsage(window),
  });
}

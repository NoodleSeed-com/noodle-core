import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { normalizedTimestamps } from '../http-util.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { UserAppLogLevel, UserAppLogStore } from '../store/user-app-logs.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

/**
 * `GET /v1/orgs/{org}/apps/{app}/envs/{env}/logs` — the tenant-safe developer log surface (M3, ADR 0101).
 * Tenant-scoped via the same control gate as `inspect`; returns redacted, bounded, newest-first records.
 */
export async function handleUserAppLogs(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  logs: UserAppLogStore,
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
  const limit = parseLogLimit(url.searchParams.get('limit'));
  if (limit === false)
    return sendJson(res, 400, { error: '"limit" must be an integer from 1 to 200' });
  const level = url.searchParams.get('level') ?? undefined;
  if (level !== undefined && !LOG_LEVELS.has(level)) {
    return sendJson(res, 400, { error: '"level" must be one of debug, info, warn, error' });
  }
  const contains = url.searchParams.get('search') ?? undefined;
  if (contains !== undefined && contains.length > 200) {
    return sendJson(res, 400, { error: '"search" must be at most 200 characters' });
  }
  const ts = normalizedTimestamps(res, {
    since: url.searchParams.get('since') ?? undefined,
    until: url.searchParams.get('until') ?? undefined,
  });
  if (ts === undefined) return;
  try {
    const events = await logs.list({
      org: ref.org,
      app: ref.app,
      env: ref.env,
      ...(limit !== undefined ? { limit } : {}),
      ...(level !== undefined ? { level: level as UserAppLogLevel } : {}),
      ...(contains !== undefined ? { contains } : {}),
      ...(ts.since !== undefined ? { since: ts.since } : {}),
      ...(ts.until !== undefined ? { until: ts.until } : {}),
    });
    return sendJson(res, 200, { ok: true, events });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
}

const LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);

function parseLogLimit(value: string | null): number | undefined | false {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) return false;
  return parsed;
}

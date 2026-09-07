import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { RequestEventStore } from '@noodle-borg/module';
import { aggregateRequestEvents, parseRequestEventQuery } from '@noodle-borg/observability';
import { sendJson } from '@noodle-borg/transport-http';
import { normalizedTimestamps } from '../http-util.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

/**
 * Tenant analytics read routes (ADR 0121 Stage B): `metrics` (aggregated), `events` (the stream), and
 * `sessions/{id}` (one session's request sequence). All are org-membership gated and read only the
 * tenant's own slice of the request-event stream; records are scalar-only by construction.
 */

// A Map, not a Record: the key is caller-controlled, and a Record lookup would walk the prototype
// chain (`?window=toString` would resolve to a function instead of undefined).
const WINDOWS_MS = new Map<string, number>([
  ['24h', 24 * 60 * 60 * 1000],
  ['7d', 7 * 24 * 60 * 60 * 1000],
  ['30d', 30 * 24 * 60 * 60 * 1000],
]);

/** Session replay cap: newest N of one session, rendered chronologically. */
const SESSION_EVENTS_LIMIT = 1000;
/** Aggregation reads a bounded slice; pre-aggregated rollups are the Stage-F scale path. */
const METRICS_SCAN_LIMIT = 50_000;

export async function handleTenantMetrics(
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
  const rawSince = url.searchParams.get('since') ?? undefined;
  if (windowMs === undefined && rawSince === undefined) {
    return sendJson(res, 400, { error: '"window" must be one of 24h, 7d, 30d (or pass "since")' });
  }
  const ts = normalizedTimestamps(res, {
    since: rawSince,
    until: url.searchParams.get('until') ?? undefined,
  });
  if (ts === undefined) return;
  const until = ts.until;
  const resolvedSince =
    ts.since ?? new Date(Date.now() - (windowMs ?? WINDOWS_MS.get('7d') ?? 0)).toISOString();

  // No catch here: validation already returned 400, so a rejection is a store/infra fault that must
  // surface as the dispatcher's 500, not masquerade as a client error.
  const window = await events.list({
    org: ref.org,
    app: ref.app,
    env: ref.env,
    since: resolvedSince,
    ...(until !== undefined ? { until } : {}),
    limit: METRICS_SCAN_LIMIT,
  });
  // No silent caps: when the scan filled the limit, the aggregates are partial — say so.
  const truncated = window.length >= METRICS_SCAN_LIMIT;
  return sendJson(res, 200, {
    ok: true,
    window: { since: resolvedSince, ...(until !== undefined ? { until } : {}) },
    ...(truncated ? { truncated: true } : {}),
    metrics: aggregateRequestEvents(window),
  });
}

export async function handleTenantEvents(
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

  const query = parseRequestEventQuery(url.searchParams, ref);
  if (!query.ok) return sendJson(res, 400, { error: query.error });

  // Store rejections surface as the dispatcher's 500 (validation above already handled 400s).
  return sendJson(res, 200, { ok: true, events: await events.list(query.filter) });
}

export async function handleTenantSession(
  req: IncomingMessage,
  res: ServerResponse,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  events: RequestEventStore,
  ref: TenantRef,
  sessionId: string,
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
  // Store rejections surface as the dispatcher's 500. Bounded like every read: a hostile or reused
  // session id must not stream an arbitrarily large payload (newest N, shown chronologically).
  const records = await events.list({
    org: ref.org,
    app: ref.app,
    env: ref.env,
    sessionId,
    limit: SESSION_EVENTS_LIMIT,
  });
  // Stores return newest-first; a session view reads as a chronological sequence.
  return sendJson(res, 200, { ok: true, sessionId, events: [...records].reverse() });
}

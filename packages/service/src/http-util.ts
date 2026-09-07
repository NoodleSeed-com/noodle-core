import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  effectiveProto,
  type Logger,
  sendJson,
  type TlsPosture,
} from '@noodle-borg/transport-http';

/**
 * Log a thrown route error (redacted to name/message/short-stack — never a body, key, or secret) and
 * answer 500 if the response hasn't already started. The shared catch tail for async route handlers so
 * a thrown failure is observable, not a silent hang or a leaked stack.
 */
export function respondRouteError(
  logger: Logger,
  res: ServerResponse,
  event: string,
  error: unknown,
): void {
  logger.error(event, {
    name: error instanceof Error ? error.name : 'unknown',
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? (error.stack ?? '').split('\n').slice(0, 4).join(' | ') : '',
  });
  if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
}

/**
 * Validate timestamp query params AND normalize them to canonical `toISOString()` form. `Date.parse`
 * accepts more than ISO-8601 (RFC 2822, offsets), but the stores compare these values as raw strings
 * against ISO `createdAt`s — so the parsed value is re-emitted canonically instead of reused verbatim.
 * Keyed by param name (absent values pass through as `undefined`, insertion order preserved), the
 * first unparseable value gets a `sendJson(res, 400, …)` and the call returns `undefined`; callers
 * guard with `if (ts === undefined) return;` and read the normalized values from the result.
 */
export function normalizedTimestamps<K extends string>(
  res: ServerResponse,
  values: Readonly<Record<K, string | undefined>>,
): Record<K, string | undefined> | undefined {
  const normalized = {} as Record<K, string | undefined>;
  for (const [name, value] of Object.entries(values) as [K, string | undefined][]) {
    if (value === undefined) {
      normalized[name] = undefined;
      continue;
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      sendJson(res, 400, { error: `"${name}" must be an ISO-8601 timestamp` });
      return undefined;
    }
    normalized[name] = new Date(parsed).toISOString();
  }
  return normalized;
}

export function sendUnauthorized(res: ServerResponse, message = 'unauthorized'): void {
  res.writeHead(401, {
    'content-type': 'application/json; charset=utf-8',
    'www-authenticate': 'Bearer realm="noodle-deploy"',
  });
  res.end(JSON.stringify({ error: message }));
}

export function sendForbidden(res: ServerResponse, message: string): void {
  res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

export function baseFromRequest(req: IncomingMessage, tls: TlsPosture): string {
  const host = req.headers.host ?? 'localhost';
  return `${effectiveProto(req, tls.trustProxy ?? false)}://${host}`;
}

export function normalizeServiceBase(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeOAuthResource(value: string): string {
  const normalized = normalizeServiceBase(value);
  try {
    const url = new URL(normalized);
    return url.pathname === '/' && url.search === '' && url.hash === '' ? url.href : normalized;
  } catch {
    return normalized;
  }
}

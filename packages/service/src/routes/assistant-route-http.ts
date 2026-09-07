import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AssistantSessionRecord } from '@noodle-borg/assistant-gateway/portable';
import { bearerToken } from '@noodle-borg/transport-http';
import { sendForbidden, sendUnauthorized } from '../http-util.js';
import type { AssistantRouteDeps } from './assistant.js';

export function handleAssistantPreflight(req: IncomingMessage, res: ServerResponse): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : 'null';
  res.writeHead(204, {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '600',
    vary: 'Origin',
  });
  res.end();
}

export async function authenticateSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: AssistantRouteDeps,
): Promise<AssistantSessionRecord | undefined> {
  const token = bearerToken(req.headers.authorization);
  if (token === null) {
    applyBrowserCors(req, res);
    sendUnauthorized(res, 'invalid assistant session');
    return undefined;
  }
  const session = await deps.store.getSession(token, now(deps));
  if (!session) {
    applyBrowserCors(req, res);
    sendUnauthorized(res, 'invalid assistant session');
    return undefined;
  }
  if (req.headers.origin !== session.origin) {
    sendForbidden(res, 'origin is not allowed');
    return undefined;
  }
  return session;
}

export function applyBrowserCors(
  req: IncomingMessage,
  res: ServerResponse,
  expectedOrigin?: string,
): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  if (!origin || (expectedOrigin !== undefined && origin !== expectedOrigin)) return;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) return;
  } catch {
    return;
  }
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'Origin');
}

export function now(deps: AssistantRouteDeps): Date {
  return deps.clock?.() ?? new Date();
}

/** The one endpoint map every session mint returns; three mints, one source of truth. */
export function assistantSessionEndpoints(base: string) {
  return {
    turns: `${base}/v1/assistant/turns`,
    toolConfirmations: `${base}/v1/assistant/tool-confirmations`,
    interactions: `${base}/v1/assistant/interactions`,
    apps: `${base}/v1/assistant/apps`,
    sandbox: `${base}/v1/assistant/sandbox`,
    transcript: `${base}/v1/assistant/transcript`,
    suggestions: `${base}/v1/assistant/suggestions`,
  };
}

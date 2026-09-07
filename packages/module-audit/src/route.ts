import type { ServerResponse } from 'node:http';
import type { AuditFilter, AuditStore, ModuleRoute } from '@noodle-borg/module';

export function createAuditEventsRoute(store: AuditStore): ModuleRoute {
  return {
    id: 'audit.events',
    match: (method, url) => method === 'GET' && url.pathname === '/v1/audit/events',
    handle: async (req, res, ctx) => {
      if (ctx.controlPlane === undefined) {
        return sendJson(res, 401, { error: 'control-plane authentication required' });
      }
      const auth = await ctx.controlPlane.authorize(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { error: auth.message });
      }
      if (auth.identity === undefined) {
        return sendJson(res, 401, { error: 'identity required' });
      }
      if (!auth.identity.superAdmin) {
        return sendJson(res, 403, { error: 'forbidden' });
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const org = url.searchParams.get('org');
      if (org === null || org.length === 0) {
        return sendJson(res, 400, { error: 'org query parameter is required' });
      }
      try {
        const filter = auditFilterFromQuery(url, org);
        const events = await store.list(filter);
        return sendJson(res, 200, { ok: true, events });
      } catch (error) {
        return sendJson(res, 400, { error: (error as Error).message });
      }
    },
  };
}

function auditFilterFromQuery(url: URL, org: string): AuditFilter {
  const app = optionalQuery(url, 'app');
  const env = optionalQuery(url, 'env');
  const eventType = optionalQuery(url, 'eventType');
  const limit = parseLimit(optionalQuery(url, 'limit'));
  return {
    org,
    ...(app !== undefined ? { app } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(eventType !== undefined ? { eventType } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function optionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value !== null && value.length > 0 ? value : undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('limit must be an integer from 1 to 500');
  }
  return parsed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

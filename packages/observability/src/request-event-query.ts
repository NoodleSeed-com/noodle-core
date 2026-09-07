import {
  isRequestSurface,
  REQUEST_SURFACES,
  type RequestEventFilter,
  type RequestOutcome,
} from '@noodle-borg/module';

/**
 * Query parsing for the tenant-facing analytics event listing. It lives beside the store rather
 * than in the HTTP route because the vocabulary it validates — outcomes, surfaces, the bounded page
 * size — belongs to the analytics stream, not to one transport. The route keeps the HTTP concern:
 * this returns a filter or a reason, and never a response.
 */

/** Bounded page size: a tenant may ask for fewer, never for more. */
const MAX_REQUEST_EVENTS_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const OUTCOMES: ReadonlySet<string> = new Set(['ok', 'tool_error', 'mcp_error']);

export type RequestEventQuery =
  | { readonly ok: true; readonly filter: RequestEventFilter }
  | { readonly ok: false; readonly error: string };

export function parseRequestEventQuery(
  params: URLSearchParams,
  tenant: { readonly org: string; readonly app?: string; readonly env?: string },
): RequestEventQuery {
  const limitParam = params.get('limit');
  let limit = DEFAULT_LIMIT;
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REQUEST_EVENTS_LIMIT) {
      return {
        ok: false,
        error: `"limit" must be an integer from 1 to ${MAX_REQUEST_EVENTS_LIMIT}`,
      };
    }
  }
  const status = params.get('status') ?? undefined;
  if (status !== undefined && !OUTCOMES.has(status)) {
    return { ok: false, error: '"status" must be one of ok, tool_error, mcp_error' };
  }
  const surface = params.get('surface') ?? undefined;
  if (surface !== undefined && !isRequestSurface(surface)) {
    return { ok: false, error: `"surface" must be one of ${REQUEST_SURFACES.join(', ')}` };
  }
  const tool = params.get('tool') ?? undefined;
  const client = params.get('client') ?? undefined;
  return {
    ok: true,
    filter: {
      org: tenant.org,
      ...(tenant.app !== undefined ? { app: tenant.app } : {}),
      ...(tenant.env !== undefined ? { env: tenant.env } : {}),
      limit,
      ...(status !== undefined ? { outcome: status as RequestOutcome } : {}),
      ...(tool !== undefined ? { toolName: tool } : {}),
      ...(client !== undefined ? { clientName: client } : {}),
      ...(surface !== undefined ? { surface } : {}),
    },
  };
}

/**
 * The `apps` resource read routes: `GET /v1/orgs/{org}/apps` (list) and `GET /v1/orgs/{org}/apps/{app}`
 * (inspect). Membership-gated exactly like the deployments/org routes (`authorizeTenantControl`); the
 * response payload is `.parse()`d through `@noodle-borg/wire-contracts` before it goes on the
 * wire, so the shape can never drift from what's declared there. Contract-parse failures are OUR bug,
 * not the caller's: they return 500 (visible to 5xx alerting), while store/lookup failures stay 400.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { AppResponseSchema, AppsListResponseSchema } from '@noodle-borg/wire-contracts';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { ControlPlaneStore } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';
import { appWithEndpointUrl } from './endpoint-enrichment.js';

const MAX_APPS_LIMIT = 500;

export async function handleApps(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string },
  url: URL,
  endpointBase: string,
  resolveEndpointOptions: ResolveEndpointUrlOptions,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const authorized = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (authorized === false) return;
  const includeArchived = url.searchParams.get('archived') === 'true';
  const limit = parseAppsLimit(url.searchParams.get('limit'));
  if (limit === false) {
    return sendJson(res, 400, { error: `"limit" must be an integer from 1 to ${MAX_APPS_LIMIT}` });
  }
  let result: Awaited<ReturnType<ServerRegistry['listApps']>>;
  try {
    result = await registry.listApps(ref.org, {
      ...(includeArchived ? { includeArchived: true } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  const endpointOptions = await resolveEndpointOptions(ref.org);
  return sendContract(res, () =>
    AppsListResponseSchema.parse({
      ok: true,
      data: {
        ...result,
        apps: result.apps.map((app) => appWithEndpointUrl(app, endpointBase, endpointOptions)),
      },
    }),
  );
}

export async function handleApp(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string; app: string },
  endpointBase: string,
  resolveEndpointOptions: ResolveEndpointUrlOptions,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const authorized = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (authorized === false) return;
  let app: Awaited<ReturnType<ServerRegistry['getApp']>>;
  try {
    app = await registry.getApp(ref.org, ref.app);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  if (app === undefined) return sendJson(res, 404, { error: 'not found' });
  const endpointOptions = await resolveEndpointOptions(ref.org);
  const enriched = appWithEndpointUrl(app, endpointBase, endpointOptions);
  return sendContract(res, () => AppResponseSchema.parse({ ok: true, data: enriched }));
}

/**
 * Send a contract-parsed body; a parse throw means the SERVICE broke its own wire contract
 * (e.g. an aggregation bug), so report 500 — never blame the client with a 400.
 */
export function sendContract(res: ServerResponse, build: () => unknown): void {
  let body: unknown;
  try {
    body = build();
  } catch {
    sendJson(res, 500, { error: 'internal error' });
    return;
  }
  sendJson(res, 200, body);
}

function parseAppsLimit(value: string | null): number | undefined | false {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_APPS_LIMIT) return false;
  return parsed;
}

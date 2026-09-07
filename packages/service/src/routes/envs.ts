/**
 * The `envs` resource read routes: `GET /v1/orgs/{org}/apps/{app}/envs` (list) and
 * `GET /v1/orgs/{org}/apps/{app}/envs/{env}` (inspect). Membership-gated exactly like the `apps`
 * routes (`authorizeTenantControl`); the response payload is `.parse()`d through
 * `@noodle-borg/wire-contracts` before it goes on the wire, so the shape cannot drift from what's declared
 * there. Contract-parse failures return 500 via `sendContract` (our bug, not the caller's); store
 * lookups keep 400. No pagination — env counts per app are small.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { EnvResponseSchema, EnvsListResponseSchema } from '@noodle-borg/wire-contracts';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { ControlPlaneStore } from '../store.js';
import { sendContract } from './apps.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';
import { envWithEndpointUrl } from './endpoint-enrichment.js';

export async function handleEnvs(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string; app: string },
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
  let envs: Awaited<ReturnType<ServerRegistry['listEnvironments']>>;
  try {
    // Distinguish "app has no envs yet" (200, empty list) from "app does not exist" (404) — the same
    // way `handleApp` treats a missing `getApp` result as not-found.
    const app = await registry.getApp(ref.org, ref.app);
    if (app === undefined) return sendJson(res, 404, { error: 'not found' });
    envs = await registry.listEnvironments(ref.org, ref.app, {
      ...(includeArchived ? { includeArchived: true } : {}),
    });
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  const endpointOptions = await resolveEndpointOptions(ref.org);
  return sendContract(res, () =>
    EnvsListResponseSchema.parse({
      ok: true,
      data: { envs: envs.map((env) => envWithEndpointUrl(env, endpointBase, endpointOptions)) },
    }),
  );
}

export async function handleEnv(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { org: string; app: string; env: string },
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
  let env: Awaited<ReturnType<ServerRegistry['getEnvironment']>>;
  try {
    env = await registry.getEnvironment(ref.org, ref.app, ref.env);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  if (env === undefined) return sendJson(res, 404, { error: 'not found' });
  const endpointOptions = await resolveEndpointOptions(ref.org);
  const enriched = envWithEndpointUrl(env, endpointBase, endpointOptions);
  return sendContract(res, () => EnvResponseSchema.parse({ ok: true, data: enriched }));
}

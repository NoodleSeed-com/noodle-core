import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerToken } from '@noodle-borg/control-plane/portable';
import { normalizeServerVersion, tenantMcpUrl } from '@noodle-borg/module';
import {
  type CredentialProbeRouteResolver,
  type DelegatedCredentialProbe,
  freezeCustomerRoutes,
  resolveCustomerRouteBinding,
} from '@noodle-borg/runtime';
import { sendJson } from '@noodle-borg/transport-http';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { ServerRegistry } from '../registry.js';
import type { TenantRef } from '../store.js';

export interface LiveAuthDoctorOptions {
  readonly serviceBase: string;
  readonly resolveEndpointOptions?: ResolveEndpointUrlOptions;
  readonly serverVersion?: string;
}

/** Verify one real customer identity and probe delegated bindings without calling business APIs. */
export async function handleLiveAuthDoctor(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  tenant: TenantRef,
  options: LiveAuthDoctorOptions,
): Promise<void> {
  let serverVersion: string | undefined;
  try {
    serverVersion =
      options.serverVersion === undefined
        ? undefined
        : normalizeServerVersion(options.serverVersion);
  } catch (error) {
    return sendJson(res, 400, { ok: false, error: (error as Error).message });
  }
  const target =
    serverVersion === undefined
      ? await registry.getActiveByTenant(tenant)
      : await registry.getActiveByTenantVersion(tenant, serverVersion);
  if (target === undefined) return sendJson(res, 404, { ok: false, error: 'deployment not found' });
  if (target.accessMode !== 'customers' || target.verifyToken === undefined) {
    return sendJson(res, 409, {
      ok: false,
      error: 'live auth doctor requires a customers deployment with customer auth',
    });
  }
  const token = bearerToken(req);
  if (token === null)
    return sendJson(res, 401, { ok: false, error: 'missing customer bearer token' });
  const endpointOptions = await options.resolveEndpointOptions?.(tenant.org);
  const resource = tenantMcpUrl(options.serviceBase, tenant, serverVersion, endpointOptions);
  const verification = await target.verifyToken(token, resource).catch(() => null);
  if (verification === null || verification.caller.identityKind !== 'customer') {
    return sendJson(res, 401, { ok: false, error: 'customer token verification failed' });
  }
  const probe = target.served.deps.broker.probeDelegatedCredentials;
  if (probe === undefined) {
    return sendJson(res, 409, {
      ok: false,
      error: 'deployment credential broker does not support live diagnostics',
    });
  }
  const routes = freezeCustomerRoutes(
    target.served.artifact.customerEndpoints,
    verification.customerRouting,
  );
  const resolveRoute: CredentialProbeRouteResolver = (requirement) =>
    resolveCustomerRouteBinding(routes, requirement);
  const checks: readonly DelegatedCredentialProbe[] = await probe.call(
    target.served.deps.broker,
    verification.caller,
    resolveRoute,
    verification.customerIssuer,
  );
  return sendJson(res, 200, {
    ok: checks.every((check) => check.ok),
    resource,
    checks,
  });
}

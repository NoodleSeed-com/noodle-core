import {
  type PublicMcpRouteRef,
  parseCanonicalLegacyTenantMcpUrl,
  parseCanonicalPublicMcpUrl,
  type TenantRouteRef,
} from '@noodle-borg/module';
import type { ServerRegistry } from '../registry.js';

export interface ServicePrincipalResourceRouting {
  readonly legacyOrigin: string;
  readonly allowedBaseDomains: readonly string[];
  readonly resolveTenant: (ref: PublicMcpRouteRef) => Promise<TenantRouteRef | undefined>;
}

export interface ResolvedServicePrincipalResource {
  readonly resource: string;
  readonly tenant: TenantRouteRef;
  readonly deploymentId?: string;
}

/** Resolve only a byte-exact canonical MCP resource that is actively served right now. */
export async function resolveServicePrincipalResource(
  resource: string,
  registry: ServerRegistry,
  routing: ServicePrincipalResourceRouting,
): Promise<ResolvedServicePrincipalResource | undefined> {
  const tenant = await exactTenant(resource, routing);
  if (tenant === undefined) return undefined;
  const target =
    tenant.serverVersion === undefined
      ? await registry.getActiveByTenant(tenant)
      : await registry.getActiveByTenantVersion(tenant, tenant.serverVersion);
  if (target === undefined) return undefined;
  return {
    resource,
    tenant,
    ...(target.deploymentId === undefined ? {} : { deploymentId: target.deploymentId }),
  };
}

async function exactTenant(
  resource: string,
  routing: ServicePrincipalResourceRouting,
): Promise<TenantRouteRef | undefined> {
  const publicRef = parseCanonicalPublicMcpUrl(resource, routing.allowedBaseDomains);
  if (publicRef !== undefined) {
    return routing.resolveTenant(publicRef);
  }
  return parseCanonicalLegacyTenantMcpUrl(resource, routing.legacyOrigin);
}

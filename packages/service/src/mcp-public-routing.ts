import type { IncomingMessage } from 'node:http';
import {
  mcpSubdomainEndpointOptions,
  resolveMcpSubdomainTenant,
} from '@noodle-borg/control-plane/portable';
import type { PublicMcpRouteRef, TenantRouteRef } from '@noodle-borg/module';
import {
  resolveTrustedPublicOrg,
  resolveTrustedTenantMcpResource,
} from '@noodle-borg/transport-http';
import type { ServiceOptions } from './options.js';
import type { ControlPlaneStore } from './store.js';

export function trustedMcpResourceFromRequest(
  req: IncomingMessage,
  options: ServiceOptions,
  controlPlane: ControlPlaneStore,
): ReturnType<typeof resolveTrustedTenantMcpResource> {
  return resolveTrustedTenantMcpResource(
    req,
    mcpRoutingOptions(options, controlPlane).publicTenantRouting,
  );
}

export function trustedPublicOrgWellKnownFromRequest(
  req: IncomingMessage,
  options: ServiceOptions,
  expectedPath: string,
  controlPlane: ControlPlaneStore,
): ReturnType<typeof resolveTrustedPublicOrg> {
  return resolveTrustedPublicOrg(req, trustedRouting(options), expectedPath, async (mcpSubdomain) =>
    controlPlane.resolveActiveMcpSubdomain(mcpSubdomain).then((claim) => claim?.orgSlug),
  );
}

export function allowedMcpBaseDomains(options: ServiceOptions): readonly string[] {
  return (
    options.mcpPublicRouting?.allowedBaseDomains ??
    (options.mcpPublicRouting?.publicBaseDomain !== undefined
      ? [options.mcpPublicRouting.publicBaseDomain]
      : [])
  );
}

/** Derive the public endpoint and trusted edge-routing options from one service configuration. */
export function mcpRoutingOptions(
  options: ServiceOptions,
  controlPlane: ControlPlaneStore,
): {
  readonly publicTenantRouting?: {
    readonly allowedBaseDomains: readonly string[];
    readonly edgeToken: string;
    readonly resolveTenant: (ref: PublicMcpRouteRef) => Promise<TenantRouteRef | undefined>;
  };
} {
  const edgeToken = options.mcpPublicRouting?.edgeToken;
  return {
    ...(edgeToken === undefined
      ? {}
      : {
          publicTenantRouting: {
            allowedBaseDomains: allowedMcpBaseDomains(options),
            edgeToken,
            resolveTenant: (ref: PublicMcpRouteRef) => resolveMcpSubdomainTenant(controlPlane, ref),
          },
        }),
  };
}

export type ResolveEndpointUrlOptions = (
  org: string,
) => Promise<{ readonly publicBaseDomain?: string; readonly mcpSubdomain?: string }>;

export function endpointUrlOptionsForOrg(
  options: ServiceOptions,
  controlPlane: ControlPlaneStore,
  org: string,
) {
  return mcpSubdomainEndpointOptions(controlPlane, org, options.mcpPublicRouting?.publicBaseDomain);
}

function trustedRouting(options: ServiceOptions) {
  const edgeToken = options.mcpPublicRouting?.edgeToken;
  return edgeToken === undefined
    ? undefined
    : { edgeToken, allowedBaseDomains: allowedMcpBaseDomains(options) };
}

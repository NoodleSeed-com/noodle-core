import type { IncomingMessage } from 'node:http';
import type { PublicMcpRouteRef, TenantRouteRef } from '@noodle-borg/module';
import { parseLegacyTenantMcpPath, parsePublicMcpUrl } from '@noodle-borg/module';
import { canonicalPublicResourceUrl, edgeTokenMatches } from './public-routing.js';
import { header } from './request-capture.js';

const SERVER_PATH = /^\/([^/]+)\/mcp$/;

export interface PublicTenantRouting {
  readonly allowedBaseDomains: readonly string[];
  readonly edgeToken: string;
  readonly resolveTenant: (ref: PublicMcpRouteRef) => Promise<TenantRouteRef | undefined>;
}

type ParsedRoute =
  | {
      readonly kind: 'tenant';
      readonly ref: TenantRouteRef;
      readonly logId: string;
      readonly publicResourceUrl?: string;
    }
  | { readonly kind: 'deployment'; readonly deploymentId: string; readonly logId: string };

export type RouteResolution =
  | { readonly ok: true; readonly route: ParsedRoute | null }
  | { readonly ok: false; readonly status: 403 };

export async function resolveRoute(
  req: IncomingMessage,
  pathname: string,
  publicTenantRouting: PublicTenantRouting | undefined,
): Promise<RouteResolution> {
  const forwardedHost = header(req, 'x-app-host');
  if (forwardedHost !== undefined) {
    if (
      publicTenantRouting === undefined ||
      !edgeTokenMatches(header(req, 'x-noodle-edge-token'), publicTenantRouting.edgeToken)
    ) {
      return { ok: false, status: 403 };
    }
    const publicRef = parsePublicMcpUrl(forwardedHost, publicTenantRouting.allowedBaseDomains);
    if (publicRef === undefined) return { ok: true, route: null };
    const ref = await publicTenantRouting.resolveTenant(publicRef);
    if (ref === undefined) return { ok: true, route: null };
    return {
      ok: true,
      route: {
        kind: 'tenant',
        ref,
        logId: tenantLogId(ref),
        publicResourceUrl: canonicalPublicResourceUrl(forwardedHost),
      },
    };
  }
  return { ok: true, route: parseRoute(pathname) };
}

function parseRoute(pathname: string): ParsedRoute | null {
  const tenant = parseLegacyTenantMcpPath(pathname);
  if (tenant !== undefined) {
    return { kind: 'tenant', ref: tenant, logId: tenantLogId(tenant) };
  }
  const deployment = SERVER_PATH.exec(pathname);
  if (deployment) {
    const deploymentId = safeDecode(deployment[1] as string);
    if (deploymentId === null) return null;
    return { kind: 'deployment', deploymentId, logId: deploymentId };
  }
  return null;
}

function tenantLogId(ref: TenantRouteRef): string {
  return `${ref.org}/${ref.app}/${ref.env}${ref.serverVersion !== undefined ? `@${ref.serverVersion}` : ''}`;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

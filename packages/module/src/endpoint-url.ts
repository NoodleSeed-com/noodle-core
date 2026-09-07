import { formatPublicMcpUrl, serverVersionPathSegment } from './contract.js';

export interface DeploymentOperationTarget {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

export interface EndpointUrlOptions {
  readonly publicBaseDomain?: string;
  readonly mcpSubdomain?: string;
}

export function tenantMcpUrl(
  base: string,
  tenant: DeploymentOperationTarget,
  serverVersion?: string,
  options: EndpointUrlOptions = {},
): string {
  if (options.publicBaseDomain !== undefined) {
    if (options.mcpSubdomain === undefined) {
      throw new Error('MCP subdomain is required to format a public endpoint URL');
    }
    return formatPublicMcpUrl(options.publicBaseDomain, {
      mcpSubdomain: options.mcpSubdomain,
      app: tenant.app,
      env: tenant.env,
      ...(serverVersion !== undefined ? { serverVersion } : {}),
    });
  }
  const versionPath =
    serverVersion !== undefined ? `/${serverVersionPathSegment(serverVersion)}` : '';
  const origin = new URL(base).origin;
  return tenant.env === 'prod'
    ? `${origin}/o/${tenant.org}/${tenant.app}${versionPath}/mcp`
    : `${origin}/o/${tenant.org}/${tenant.app}/${tenant.env}${versionPath}/mcp`;
}

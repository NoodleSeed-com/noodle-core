import type { IncomingMessage, ServerResponse } from 'node:http';
import { protectedResourceMetadata } from '@noodle-borg/auth';
import { parseLegacyTenantMcpPath } from '@noodle-borg/module';
import {
  applySecurityHeaders,
  enforceHttps,
  sendJson,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import { DEVELOPER_MCP_PATH, developerMcpScopes } from '../developer-mcp/mount.js';
import { baseFromRequest } from '../http-util.js';
import { trustedMcpResourceFromRequest } from '../mcp-public-routing.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import { authorizationMetadataForTenant } from '../registry-targets.js';
import type { ControlPlaneStore } from '../store.js';

/** Well-known prefix for OAuth 2.0 Protected Resource Metadata (RFC 9728). */
const PROTECTED_RESOURCE_METADATA_PREFIX = '/.well-known/oauth-protected-resource';

export function dispatchProtectedResourceMetadata(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  registry: ServerRegistry,
  controlPlane: ControlPlaneStore,
  options: ServiceOptions,
  tls: TlsPosture,
): boolean {
  if (req.method !== 'GET' || !url.pathname.startsWith(PROTECTED_RESOURCE_METADATA_PREFIX)) {
    return false;
  }
  applySecurityHeaders(res, tls);
  if (enforceHttps(req, res, tls)) return true;
  void Promise.resolve()
    .then(async () => {
      const trustedResource = await trustedMcpResourceFromRequest(req, options, controlPlane);
      if (trustedResource.status !== 'none' && !trustedResource.ok) {
        return sendJson(res, trustedResource.status, {
          error: trustedResource.status === 403 ? 'forbidden' : 'not found',
        });
      }
      const base = options.publicBaseUrl ?? baseFromRequest(req, tls);
      const resourcePath = url.pathname.slice(PROTECTED_RESOURCE_METADATA_PREFIX.length);
      const tenant =
        trustedResource.status === 'ok'
          ? trustedResource.tenant
          : parseLegacyTenantMcpPath(resourcePath);
      const tenantAuthorization =
        tenant === undefined ? undefined : await authorizationMetadataForTenant(registry, tenant);
      const authServerIssuers =
        tenantAuthorization?.authorizationServers ??
        (options.authServerIssuer ? [options.authServerIssuer] : undefined);
      const scopesSupported =
        options.developerMcp === true && resourcePath === DEVELOPER_MCP_PATH
          ? developerMcpScopes()
          : tenantAuthorization?.requiredScopes;
      const doc = {
        ...protectedResourceMetadata({
          resource:
            trustedResource.status === 'ok'
              ? trustedResource.resourceUrl
              : `${base}${resourcePath}`,
          ...(authServerIssuers ? { authorizationServers: authServerIssuers } : {}),
          ...(scopesSupported && scopesSupported.length > 0 ? { scopesSupported } : {}),
        }),
      };
      return sendJson(res, 200, doc);
    })
    .catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  return true;
}

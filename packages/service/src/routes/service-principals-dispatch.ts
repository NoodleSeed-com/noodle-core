import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import {
  applySecurityHeaders,
  enforceHttps,
  type Logger,
  sendJson,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import type { ServicePrincipalRuntime } from '../oauth/service-principal-store.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { parseServicePrincipalPath } from './service-principal-paths.js';
import { handleServicePrincipalRequest } from './service-principals.js';

interface ServicePrincipalsDispatchDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly registry: ServerRegistry;
  readonly runtime: ServicePrincipalRuntime;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly logger: Logger;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

type BoundServicePrincipalDeps = Omit<
  ServicePrincipalsDispatchDeps,
  'applySecurityHeaders' | 'enforceHttps' | 'registry' | 'runtime' | 'sendJson'
>;

/** Bind the shared security front door when the optional service-principal runtime is configured. */
export function createServicePrincipalDispatcher(
  registry: ServerRegistry,
  runtime: ServicePrincipalRuntime | undefined,
  deps: BoundServicePrincipalDeps,
): ((req: IncomingMessage, res: ServerResponse, url: URL) => boolean) | undefined {
  if (runtime === undefined) return undefined;
  return (req, res, url) =>
    dispatchServicePrincipalRoutes(req, res, url, {
      ...deps,
      registry,
      runtime,
      applySecurityHeaders,
      enforceHttps,
      sendJson,
    });
}

/** Dispatch the exact service-principal route family before generic MCP/tenant fallback. */
function dispatchServicePrincipalRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServicePrincipalsDispatchDeps,
): boolean {
  const path = parseServicePrincipalPath(url.pathname);
  if (path === undefined) return false;
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  handleServicePrincipalRequest(req, res, path, deps).catch(() => {
    deps.logger.error('service_principal.request.failed', { reason: 'operation_failed' });
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}

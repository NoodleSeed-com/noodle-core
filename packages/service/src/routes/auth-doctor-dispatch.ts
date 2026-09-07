import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { ServerRegistry } from '../registry.js';
import { handleLiveAuthDoctor } from './auth-doctor-live.js';
import { parseTenantAuthDoctorPath } from './paths.js';

interface AuthDoctorDispatchDeps {
  readonly registry: ServerRegistry;
  readonly serviceBase: string;
  readonly resolveEndpointOptions: ResolveEndpointUrlOptions;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

/** Dispatch the customer-authenticated live credential probe without growing the root service router. */
export function dispatchAuthDoctorRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: AuthDoctorDispatchDeps,
): boolean {
  const tenant = parseTenantAuthDoctorPath(url.pathname);
  if (req.method !== 'POST' || tenant === undefined) return false;
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  const serverVersion = url.searchParams.has('version')
    ? (url.searchParams.get('version') ?? '')
    : undefined;
  handleLiveAuthDoctor(req, res, deps.registry, tenant, {
    serviceBase: deps.serviceBase,
    resolveEndpointOptions: deps.resolveEndpointOptions,
    ...(serverVersion === undefined ? {} : { serverVersion }),
  }).catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { ok: false, error: 'internal error' });
  });
  return true;
}

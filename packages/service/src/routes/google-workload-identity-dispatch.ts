import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { ServerRegistry } from '../registry.js';
import type { GoogleWorkloadIdentityRouteDeps } from './google-workload-identity.js';
import {
  handleGoogleWorkloadIdentity,
  handleGoogleWorkloadIdentityDoctor,
} from './google-workload-identity.js';
import { parseGoogleWorkloadIdentityDoctorPath, parseGoogleWorkloadIdentityPath } from './paths.js';

interface GoogleWorkloadIdentityDispatchDeps extends GoogleWorkloadIdentityRouteDeps {
  readonly registry: ServerRegistry;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

export function dispatchGoogleWorkloadIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: GoogleWorkloadIdentityDispatchDeps | undefined,
): boolean {
  const doctorTenant = parseGoogleWorkloadIdentityDoctorPath(url.pathname);
  if (doctorTenant !== undefined && req.method === 'POST' && deps !== undefined) {
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    handleGoogleWorkloadIdentityDoctor(req, res, doctorTenant, deps).catch(() => {
      if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const tenant = parseGoogleWorkloadIdentityPath(url.pathname);
  if (
    tenant === undefined ||
    !['GET', 'PUT', 'DELETE'].includes(req.method ?? '') ||
    deps === undefined
  ) {
    return false;
  }
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  handleGoogleWorkloadIdentity(req, res, tenant, deps).catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}

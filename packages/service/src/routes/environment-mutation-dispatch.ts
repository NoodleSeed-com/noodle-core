import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { handleProductionEnvironment } from './environment-production.js';
import { parseProductionEnvironmentPath } from './paths.js';

export interface EnvironmentMutationDeps {
  readonly registry: ServerRegistry;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

export function dispatchEnvironmentMutations(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: EnvironmentMutationDeps,
): boolean {
  const ref = parseProductionEnvironmentPath(url.pathname);
  if (ref === undefined || req.method !== 'PUT') return false;
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  handleProductionEnvironment(
    req,
    res,
    deps.registry,
    deps.gate,
    deps.controlPlane,
    deps.audit,
    deps.maxBody,
    ref,
  ).catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}

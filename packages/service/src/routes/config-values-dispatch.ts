import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { TlsPosture } from '@noodle-borg/transport-http';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ConfigStore, ControlPlaneStore } from '../store.js';
import { handleConfigValues } from './config-values.js';
import { parseConfigPath } from './config-values-paths.js';

export interface ConfigValueDispatchDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly configStore: ConfigStore;
  readonly registry: ServerRegistry;
  readonly maxBody: number;
  readonly audit: AuditSink;
  readonly developerGrants?: DeveloperGrantStore;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
}

export function dispatchConfigValueRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ConfigValueDispatchDeps,
): boolean {
  const ref = parseConfigPath(url.pathname, url.searchParams);
  if (ref === undefined) return false;
  if (ref.reveal) res.setHeader('Cache-Control', 'no-store');
  if (ref.reveal && ref.invalid !== undefined) {
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    deps.sendJson(res, 400, { error: ref.invalid });
    return true;
  }
  if (ref.reveal && req.method !== 'POST') {
    deps.applySecurityHeaders(res, deps.tls);
    if (deps.enforceHttps(req, res, deps.tls)) return true;
    deps.sendJson(res, 404, { error: 'not found' });
    return true;
  }
  if (!ref.reveal && !isConfigMethod(req.method)) return false;
  deps.applySecurityHeaders(res, deps.tls);
  if (deps.enforceHttps(req, res, deps.tls)) return true;
  handleConfigValues(
    req,
    res,
    deps.gate,
    deps.controlPlane,
    deps.configStore,
    deps.registry,
    deps.maxBody,
    ref,
    deps.audit,
    deps.developerGrants,
  ).catch(() => {
    if (!res.headersSent) deps.sendJson(res, 500, { error: 'internal error' });
  });
  return true;
}

function isConfigMethod(method: string | undefined): boolean {
  return method === 'GET' || method === 'PUT' || method === 'DELETE';
}

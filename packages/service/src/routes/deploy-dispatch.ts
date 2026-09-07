import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import {
  applySecurityHeaders,
  enforceHttps,
  type Logger,
  type TlsPosture,
} from '@noodle-borg/transport-http';
import type { ArchiveSweeper } from '../archive-sweeper.js';
import { respondRouteError } from '../http-util.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { handleDeploy } from './control-plane.js';
import { handleDeployPreflight } from './deploy-preflight.js';
import { handleDeploymentLockUpdate } from './deployment-lock.js';
import {
  parseTenantDeploymentLockPath,
  parseTenantDeployPath,
  parseTenantDeployPreflightPath,
} from './paths.js';

export function dispatchDeployRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: {
    readonly registry: ServerRegistry;
    readonly options: ServiceOptions;
    readonly maxBody: { readonly deploy: number; readonly control: number };
    readonly gate: DeployAuthGate;
    readonly controlPlane: ControlPlaneStore;
    readonly audit: AuditSink;
    readonly archiveSweeper: ArchiveSweeper;
    readonly logger: Logger;
    readonly tls: TlsPosture;
  },
): boolean {
  const deploymentLock = parseTenantDeploymentLockPath(url.pathname);
  if (req.method === 'PATCH' && deploymentLock !== undefined) {
    applySecurityHeaders(res, deps.tls);
    if (enforceHttps(req, res, deps.tls)) return true;
    handleDeploymentLockUpdate(
      req,
      res,
      deps.registry,
      deps.gate,
      deps.controlPlane,
      deps.audit,
      deps.maxBody.control,
      deploymentLock,
    ).catch((error: unknown) =>
      respondRouteError(deps.logger, res, 'deployment-lock.error', error),
    );
    return true;
  }

  const preflight = parseTenantDeployPreflightPath(url.pathname);
  if (req.method === 'POST' && preflight !== undefined) {
    applySecurityHeaders(res, deps.tls);
    if (enforceHttps(req, res, deps.tls)) return true;
    handleDeployPreflight(
      req,
      res,
      deps.registry,
      deps.options,
      deps.maxBody.deploy,
      preflight,
      deps.gate,
      deps.controlPlane,
      deps.audit,
    ).catch((error: unknown) =>
      respondRouteError(deps.logger, res, 'deploy.preflight.error', error),
    );
    return true;
  }

  const deploy = parseTenantDeployPath(url.pathname);
  if (req.method !== 'POST' || deploy === undefined) return false;
  applySecurityHeaders(res, deps.tls);
  if (enforceHttps(req, res, deps.tls)) return true;
  deps.archiveSweeper.maybeSweep();
  handleDeploy(
    req,
    res,
    deps.registry,
    deps.options,
    deps.maxBody.deploy,
    deploy,
    deps.gate,
    deps.controlPlane,
    deps.audit,
  ).catch((error: unknown) => respondRouteError(deps.logger, res, 'deploy.error', error));
  return true;
}

/**
 * Dispatch for the ADR 0128 control-plane READ surface: org inspect, apps list/item, envs
 * list/item, and deployment item. Extracted verbatim from `service.ts` (which stays a thin
 * composition root under the size gate) — each block keeps the file's uniform
 * parse → security headers → https guard → handler → catch-500 shape.
 *
 * Ordering note preserved from `service.ts`: `parseEnvsPath`/`parseEnvItemPath` only match a bare
 * `/envs` or `/envs/{env}` with nothing after it, so they can never shadow the action-suffixed
 * tenant routes (deploy, status, access, rollback, inspect, smoke, logs, assets/preflight,
 * secrets, variables) regardless of dispatch order.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { Logger, TlsPosture } from '@noodle-borg/transport-http';
import type { ResolveEndpointUrlOptions } from '../mcp-public-routing.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { ControlPlaneStore } from '../store.js';
import { handleApp, handleApps } from './apps.js';
import { handleDeploymentPackage } from './deployment-package.js';
import { handleDeploymentItem } from './deployments.js';
import type { ResolveEndpointBase } from './endpoint-enrichment.js';
import { handleEnv, handleEnvs } from './envs.js';
import {
  parseAppItemPath,
  parseAppsPath,
  parseDeploymentItemPath,
  parseDeploymentPackagePath,
  parseEnvItemPath,
  parseEnvsPath,
} from './paths.js';

export interface ResourceReadDeps {
  readonly registry: ServerRegistry;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly applySecurityHeaders: (res: ServerResponse, tls: TlsPosture) => void;
  readonly enforceHttps: (req: IncomingMessage, res: ServerResponse, tls: TlsPosture) => boolean;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly tls: TlsPosture;
  readonly resolveEndpointBase: ResolveEndpointBase;
  readonly resolveEndpointOptions: ResolveEndpointUrlOptions;
  readonly developerGrantStore: DeveloperGrantStore | undefined;
  readonly logger: Logger;
}

/**
 * Try the resource read routes; returns true when the request was handled (or a guard ended it).
 * `orgRef` GET (org inspect) stays in `service.ts` beside its PATCH sibling, which shares the parse.
 */
export function dispatchResourceReads(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ResourceReadDeps,
): boolean {
  const {
    registry,
    gate,
    controlPlane,
    applySecurityHeaders,
    enforceHttps,
    sendJson,
    tls,
    resolveEndpointBase,
    resolveEndpointOptions,
    developerGrantStore,
    logger,
  } = deps;
  const endpointBase = resolveEndpointBase(req);

  const appsRef = parseAppsPath(url.pathname);
  if (appsRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleApps(
      req,
      res,
      registry,
      gate,
      controlPlane,
      appsRef,
      url,
      endpointBase,
      resolveEndpointOptions,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const appItemRef = parseAppItemPath(url.pathname);
  if (appItemRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleApp(
      req,
      res,
      registry,
      gate,
      controlPlane,
      appItemRef,
      endpointBase,
      resolveEndpointOptions,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const envsRef = parseEnvsPath(url.pathname);
  if (envsRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleEnvs(
      req,
      res,
      registry,
      gate,
      controlPlane,
      envsRef,
      url,
      endpointBase,
      resolveEndpointOptions,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const envItemRef = parseEnvItemPath(url.pathname);
  if (envItemRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleEnv(
      req,
      res,
      registry,
      gate,
      controlPlane,
      envItemRef,
      endpointBase,
      resolveEndpointOptions,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const deploymentPackageRef = parseDeploymentPackagePath(url.pathname);
  if (deploymentPackageRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleDeploymentPackage(
      req,
      res,
      registry,
      gate,
      controlPlane,
      deploymentPackageRef,
      logger,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  const deploymentItemRef = parseDeploymentItemPath(url.pathname);
  if (deploymentItemRef !== undefined && req.method === 'GET') {
    applySecurityHeaders(res, tls);
    if (enforceHttps(req, res, tls)) return true;
    handleDeploymentItem(
      req,
      res,
      registry,
      gate,
      controlPlane,
      deploymentItemRef,
      endpointBase,
      resolveEndpointOptions,
      developerGrantStore,
    ).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
    return true;
  }
  return false;
}

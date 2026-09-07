import type { IncomingMessage, ServerResponse } from 'node:http';
import { sha256Canonical } from '@noodle-borg/app-package';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import type { Logger } from '@noodle-borg/transport-http';
import { sendJson } from '@noodle-borg/transport-http';
import { DeploymentPackageResponseShapeSchema } from '@noodle-borg/wire-contracts';
import { parseAppPackageSnapshot } from '../app-package-snapshot.js';
import type { DeveloperGrantStore } from '../oauth/developer-grant.js';
import type { ServerRegistry } from '../registry.js';
import type { ControlPlaneStore } from '../store.js';
import { authorizeTenantControl, developerGrantRouteAccess } from './control-plane.js';

const PACKAGE_UNAVAILABLE = {
  code: 'package_unavailable',
  error: 'deployment package is unavailable',
  next: 'noodle deploy',
} as const;

/** Authenticated, store-first historical package read. Never compiles or renders package bytes. */
export async function handleDeploymentPackage(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  ref: { readonly org: string; readonly deploymentId: string },
  logger: Logger,
  developerGrants?: DeveloperGrantStore,
): Promise<void> {
  const authorized = await authorizeTenantControl(
    req,
    res,
    gate,
    controlPlane,
    ref.org,
    developerGrantRouteAccess(developerGrants, 'cloud:read'),
  );
  if (authorized === false) return;

  const deployment = await registry.getDeployment(ref.org, ref.deploymentId);
  if (deployment === undefined) return sendJson(res, 404, { error: 'unknown deployment' });

  const deploymentPackage = await registry.getDeploymentPackage(ref.org, ref.deploymentId);
  if (deploymentPackage === undefined) return sendJson(res, 409, PACKAGE_UNAVAILABLE);
  const parsed = DeploymentPackageResponseShapeSchema.safeParse({
    ok: true,
    data: deploymentPackage,
  });
  if (!parsed.success || parseAppPackageSnapshot(parsed.data.data.snapshot) === undefined) {
    logger.warn('deployment_package.invalid_snapshot', { reason: 'schema_validation_failed' });
    return sendJson(res, 409, PACKAGE_UNAVAILABLE);
  }

  const etag = `"${sha256Canonical(parsed.data)}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  if (matchesEntityTag(req.headers['if-none-match'], etag)) {
    res.writeHead(304);
    res.end();
    return;
  }
  sendJson(res, 200, parsed.data);
}

function matchesEntityTag(header: string | readonly string[] | undefined, etag: string): boolean {
  const values: readonly string[] =
    typeof header === 'string' ? [header] : header === undefined ? [] : header;
  return values.some((value) =>
    value.split(',').some((candidate) => {
      const normalized = candidate.trim();
      return normalized === '*' || normalized.replace(/^W\//, '') === etag;
    }),
  );
}

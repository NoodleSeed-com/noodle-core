import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type DeployAuthGate,
  type DeploymentDeleteScope,
  type DeploymentDeletionDependencies,
  deleteDeploymentOperation,
} from '@noodle-borg/control-plane/portable';
import { normalizeServerVersion } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  deploymentDeleteResponseSchema,
  deploymentVersionDeleteRequestSchema,
} from '@noodle-borg/wire-contracts';
import { validateTenantRef } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';

/** An exact numeric version, or the legacy unversioned scope; never semantic-version equivalence. */
export function parseVersionDeletePath(pathname: string): DeploymentDeleteScope | undefined {
  const match = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/envs\/([^/]+)\/versions\/([^/]+)$/.exec(
    pathname,
  );
  if (!match) return undefined;
  try {
    const target = validateTenantRef({
      org: decodeURIComponent(match[1] as string),
      app: decodeURIComponent(match[2] as string),
      env: decodeURIComponent(match[3] as string),
    });
    const version = decodeURIComponent(match[4] as string);
    return {
      kind: 'version',
      org: target.org,
      target,
      ...(version === 'legacy' ? {} : { serverVersion: normalizeServerVersion(version) }),
    };
  } catch {
    return undefined;
  }
}

export async function handleDeploymentDelete(
  req: IncomingMessage,
  res: ServerResponse,
  route: DeploymentDeleteScope,
  deps: DeploymentDeletionDependencies & {
    readonly gate: DeployAuthGate;
    readonly maxBody: number;
  },
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return;
  let expectedDeploymentIds: readonly string[] | undefined;
  if (route.kind === 'version') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const parsed = deploymentVersionDeleteRequestSchema.safeParse(body.value);
    if (!parsed.success)
      return sendJson(res, 400, { error: 'Invalid version deletion confirmation.' });
    expectedDeploymentIds = parsed.data.expectedDeploymentIds;
  }
  const result = await deleteDeploymentOperation(deps, {
    actor: identity,
    scope: route,
    ...(expectedDeploymentIds === undefined ? {} : { expectedDeploymentIds }),
  });
  return result.ok
    ? sendJson(res, 200, deploymentDeleteResponseSchema.parse(result.view))
    : sendJson(res, result.status, { code: result.code, error: result.error });
}

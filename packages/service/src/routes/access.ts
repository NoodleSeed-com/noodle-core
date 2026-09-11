import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { normalizeServerVersion } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { accessUpdateRequestSchema } from '@noodle-borg/wire-contracts';
import { deploymentAuthenticationFor } from '../deployment-authentication.js';
import type { ServerRegistry } from '../registry.js';
import { deploymentOwnerSubject } from '../registry-helpers.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';
import { canManageMembers } from './org-admin.js';

export async function handleAccessUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  maxBody: number,
  tenant: TenantRef,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (!(await canManageMembers(controlPlane, tenant.org, identity))) {
    return sendJson(res, 403, {
      error: 'Only an organization owner can change environment access.',
      code: 'organization_owner_required',
    });
  }

  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = accessUpdateRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return sendJson(res, 400, { error: 'invalid access update request' });
  }

  let serverVersion: string | undefined;
  try {
    serverVersion =
      parsed.data.serverVersion === undefined
        ? undefined
        : normalizeServerVersion(parsed.data.serverVersion);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }

  const result = await registry.updateAccess(tenant, {
    accessMode: parsed.data.accessMode,
    ...(parsed.data.ownerSubject !== undefined ? { ownerSubject: parsed.data.ownerSubject } : {}),
    ...(serverVersion !== undefined ? { serverVersion } : {}),
  });
  if (!result.ok) {
    return sendJson(res, result.status, {
      error: result.message,
      code: result.code,
    });
  }

  const accessMode = result.record.accessMode ?? 'owner-only';
  const ownerSubject = deploymentOwnerSubject(result.record);
  const authentication = deploymentAuthenticationFor(result.record);
  await audit.emit({
    eventType: 'deployment.access.updated',
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    deploymentId: result.record.deploymentId,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    decision: 'allow',
    status: 200,
    details: {
      previousAccessMode: result.previousAccessMode,
      accessMode,
      ...(result.previousOwnerSubject !== undefined
        ? { previousOwnerSubject: result.previousOwnerSubject }
        : {}),
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
      accessChanged: result.accessChanged,
      ownerChanged: result.ownerChanged,
      ...(authentication !== undefined
        ? { authentication, policyChanged: result.policyChanged }
        : {}),
      changed: result.changed,
    },
  });
  return sendJson(res, 200, {
    ok: true,
    target: tenant,
    deployment: {
      deploymentId: result.record.deploymentId,
      ...(result.record.serverVersion !== undefined
        ? { serverVersion: result.record.serverVersion }
        : {}),
      accessMode,
      ...(authentication !== undefined ? { authentication } : {}),
      ...(ownerSubject !== undefined ? { ownerSubject } : {}),
    },
    previousAccessMode: result.previousAccessMode,
    ...(result.previousOwnerSubject !== undefined
      ? { previousOwnerSubject: result.previousOwnerSubject }
      : {}),
    accessChanged: result.accessChanged,
    ownerChanged: result.ownerChanged,
    ...(authentication !== undefined ? { policyChanged: result.policyChanged } : {}),
    changed: result.changed,
  });
}

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { normalizeServerVersion } from '@noodle-borg/module';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { deploymentLockRequestSchema } from '@noodle-borg/wire-contracts';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, DeploymentLock, TenantRef } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';
import { canManageMembers } from './org-admin.js';

export async function handleDeploymentLockUpdate(
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
      error: 'Only an organization owner can lock or unlock a deployed server version.',
      code: 'organization_owner_required',
    });
  }

  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = deploymentLockRequestSchema.safeParse(body.value);
  if (!parsed.success) return sendJson(res, 400, { error: 'invalid deployment lock request' });

  let serverVersion: string;
  try {
    serverVersion = normalizeServerVersion(parsed.data.serverVersion);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }

  const deploymentLock: DeploymentLock | undefined = parsed.data.locked
    ? {
        lockedAt: new Date().toISOString(),
        lockedBySubject: identity.subject,
        ...(identity.email !== undefined ? { lockedByEmail: identity.email } : {}),
      }
    : undefined;
  const result = await registry.setDeploymentLock(
    tenant,
    serverVersion,
    parsed.data.expectedDeploymentId,
    deploymentLock,
  );
  if (!result.ok) {
    if (result.reason === 'no_active_deployment') {
      return sendJson(res, 404, {
        error: 'No active deployment exists for this server version.',
        code: 'no_active_deployment',
      });
    }
    return sendJson(res, 409, {
      error: 'The active deployment changed before the lock could be updated.',
      code: 'deployment_lock_conflict',
    });
  }

  let auditRecorded = true;
  try {
    await audit.emit({
      eventType: 'deployment.lock.updated',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      deploymentId: result.record.deploymentId,
      actorSubject: identity.subject,
      ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
      decision: 'allow',
      status: 200,
      details: {
        serverVersion,
        locked: parsed.data.locked,
        changed: result.changed,
      },
    });
  } catch {
    // The lock is already committed. Report that authoritative success without inviting a retry that
    // appears to fail, and make the audit degradation explicit to the caller.
    auditRecorded = false;
  }
  return sendJson(res, 200, {
    ok: true,
    target: tenant,
    deployment: {
      deploymentId: result.record.deploymentId,
      serverVersion,
      locked: result.record.deploymentLock !== undefined,
      ...(result.record.deploymentLock !== undefined
        ? {
            deploymentLock: {
              lockedAt: result.record.deploymentLock.lockedAt,
              ...(result.record.deploymentLock.lockedByEmail !== undefined
                ? { lockedByEmail: result.record.deploymentLock.lockedByEmail }
                : {}),
            },
          }
        : {}),
    },
    changed: result.changed,
    auditRecorded,
  });
}

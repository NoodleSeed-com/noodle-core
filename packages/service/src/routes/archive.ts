/**
 * App soft-delete control plane (ADR 0117): archive and restore handlers. Both are org-owner-only
 * (the rollback gate — `canManageMembers`) and emit durable audit events. Archive stamps every
 * deployment record for the app; restore clears the stamps within the retention window and answers
 * 410 Gone once the window has elapsed (the sweeper will hard-delete).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import { CustomerAuthAudienceConflictError } from '../customer-auth-audience-binding.js';
import { sendForbidden } from '../http-util.js';
import type { ServiceOptions } from '../options.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';
import { respondDeploymentActivationError } from './deployment-activation-response.js';
import { canManageMembers } from './org-admin.js';
import type { AppRouteRef } from './paths.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function handleAppArchive(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  ref: AppRouteRef,
  options: ServiceOptions,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (!(await canManageMembers(controlPlane, ref.org, identity))) {
    return sendForbidden(res, 'forbidden');
  }
  const at = (options.clock?.() ?? new Date()).toISOString();
  const result = await registry.archiveApp(ref.org, ref.app, at);
  if (result === undefined) return sendJson(res, 404, { error: 'app not found' });
  await audit.emit({
    eventType: 'app.archived',
    org: ref.org,
    app: ref.app,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      archivedAt: result.archivedAt,
      archivedDeployments: result.archivedDeployments,
      alreadyArchived: result.alreadyArchived,
    },
  });
  return sendJson(res, 200, {
    ok: true,
    target: { org: ref.org, app: ref.app },
    archive: result,
  });
}

export async function handleAppRestore(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  ref: AppRouteRef,
  options: ServiceOptions,
  retentionDays: number,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (!(await canManageMembers(controlPlane, ref.org, identity))) {
    return sendForbidden(res, 'forbidden');
  }
  const now = options.clock?.() ?? new Date();
  const archivedAt = await registry.getAppArchivedAt(ref.org, ref.app);
  // Deterministic on the window, not on sweeper timing (ADR 0117 §5): past-retention restores are
  // 410 Gone even before the sweeper hard-deletes; after the sweep the app is a plain 404.
  if (archivedAt !== undefined && now.getTime() - Date.parse(archivedAt) > retentionDays * DAY_MS) {
    await audit.emit({
      eventType: 'app.restore.rejected',
      org: ref.org,
      app: ref.app,
      decision: 'deny',
      status: 410,
      reasonCode: 'retention_elapsed',
      actorSubject: identity.subject,
      ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
      details: { archivedAt, retentionDays },
    });
    return sendJson(res, 410, {
      error: 'archive retention window elapsed; the app is pending permanent deletion',
    });
  }
  let result: Awaited<ReturnType<ServerRegistry['restoreApp']>>;
  try {
    result = await registry.restoreApp(ref.org, ref.app);
  } catch (error) {
    if (error instanceof CustomerAuthAudienceConflictError) {
      await audit.emit({
        eventType: 'app.restore.rejected',
        org: ref.org,
        app: ref.app,
        decision: 'deny',
        status: 409,
        reasonCode: error.code,
        actorSubject: identity.subject,
        ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
      });
      return sendJson(res, 409, { error: error.message, code: error.code });
    }
    const handled = await respondDeploymentActivationError(res, error, {
      audit,
      eventType: 'app.restore.rejected',
      org: ref.org,
      app: ref.app,
      actorSubject: identity.subject,
      ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    });
    if (handled) return;
    throw error;
  }
  if (result === undefined) return sendJson(res, 404, { error: 'app not found' });
  const alreadyActive = result.restoredDeployments === 0;
  await audit.emit({
    eventType: 'app.restored',
    org: ref.org,
    app: ref.app,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: { restoredDeployments: result.restoredDeployments, alreadyActive },
  });
  return sendJson(res, 200, {
    ok: true,
    target: { org: ref.org, app: ref.app },
    restore: { restoredDeployments: result.restoredDeployments, alreadyActive },
  });
}

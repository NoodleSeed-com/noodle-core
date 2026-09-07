import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ProductionEnvironmentRequestSchema,
  ProductionEnvironmentResponseSchema,
} from '@noodle-borg/wire-contracts';
import { sendForbidden } from '../http-util.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { sendContract } from './apps.js';
import { authorizeControlPlane } from './control-plane.js';
import { canManageMembers } from './org-admin.js';
import type { AppRouteRef } from './paths.js';

export async function handleProductionEnvironment(
  req: IncomingMessage,
  res: ServerResponse,
  registry: ServerRegistry,
  gate: DeployAuthGate,
  controlPlane: ControlPlaneStore,
  audit: AuditSink,
  maxBody: number,
  ref: AppRouteRef,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, gate, { requireIdentity: true });
  if (identity === false) return;
  if (!(await canManageMembers(controlPlane, ref.org, identity))) {
    return sendForbidden(res, 'forbidden');
  }
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = ProductionEnvironmentRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return sendJson(res, 400, { error: 'body must contain only a valid environment slug' });
  }
  let result: Awaited<ReturnType<ServerRegistry['setProductionEnvironment']>>;
  try {
    result = await registry.setProductionEnvironment(ref.org, ref.app, parsed.data.environment);
  } catch (error) {
    return sendJson(res, 400, { error: (error as Error).message });
  }
  if (result === undefined) return sendJson(res, 404, { error: 'environment not found' });
  await audit.emit({
    eventType: 'environment.production_set',
    org: ref.org,
    app: ref.app,
    env: result.productionEnvironment,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      previousEnvironment: result.previousProductionEnvironment,
      productionEnvironment: result.productionEnvironment,
      changed: result.changed,
    },
  });
  return sendContract(res, () =>
    ProductionEnvironmentResponseSchema.parse({ ok: true, data: result }),
  );
}

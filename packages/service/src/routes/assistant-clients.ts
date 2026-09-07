import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { sendForbidden } from '../http-util.js';
import type { TenantRef } from '../store.js';
import type { AssistantRouteDeps } from './assistant.js';
import { now } from './assistant-route-http.js';
import { activeAssistantTarget } from './assistant-session-target.js';
import { authorizeControlPlane } from './control-plane.js';

export async function handleAssistantClients(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  id: string | undefined,
  action: 'collection' | 'rotate' | 'item',
  deps: AssistantRouteDeps,
): Promise<void> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: false });
  if (identity === false) return;
  if (identity && !identity.superAdmin) {
    const member = await deps.controlPlane.isOrgMember({
      org: tenant.org,
      subject: identity.subject,
    });
    if (!member) return sendForbidden(res, 'forbidden');
  }
  if (action === 'collection' && req.method === 'GET') {
    const clients = await deps.store.listClients(tenant);
    return sendJson(res, 200, {
      ok: true,
      clients: clients.map(publicClient),
    });
  }
  if (action === 'collection' && req.method === 'POST') {
    const body = await readJsonBody(req, deps.maxBody);
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    const name = (body.value as { name?: unknown }).name;
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 80) {
      return sendJson(res, 400, { error: '"name" must be a non-empty string' });
    }
    const target = await activeAssistantTarget({ registry: deps.registry }, tenant);
    const assistant = target?.served.artifact.server.assistant;
    if (!target?.deploymentId || !assistant)
      return sendJson(res, 409, { error: 'deployment has no embedded assistant' });
    const created = await deps.store.createClient({
      name: name.trim(),
      tenant,
      deploymentId: target.deploymentId,
      allowedOrigins: assistant.allowedOrigins,
      now: now(deps),
    });
    await deps.audit.emit({
      eventType: 'assistant.client.created',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      deploymentId: target.deploymentId,
      decision: 'allow',
      status: 201,
      ...(identity ? { actorSubject: identity.subject } : {}),
      ...(identity?.email ? { actorEmail: identity.email } : {}),
      details: { clientId: created.client.id, name: created.client.name },
    });
    return sendJson(res, 201, {
      ok: true,
      ...publicClient(created.client),
      clientSecret: created.secret,
    });
  }
  if (!id) return sendJson(res, 404, { error: 'not found' });
  const owned = (await deps.store.listClients(tenant)).some((client) => client.id === id);
  if (!owned) return sendJson(res, 404, { error: 'not found' });
  if (action === 'rotate' && req.method === 'POST') {
    const rotated = await deps.store.rotateClient(id, now(deps));
    if (!rotated) return sendJson(res, 404, { error: 'not found' });
    await deps.audit.emit({
      eventType: 'assistant.client.rotated',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      deploymentId: rotated.client.deploymentId,
      decision: 'allow',
      status: 200,
      ...(identity ? { actorSubject: identity.subject } : {}),
      ...(identity?.email ? { actorEmail: identity.email } : {}),
      details: { clientId: rotated.client.id },
    });
    return sendJson(res, 200, {
      ok: true,
      ...publicClient(rotated.client),
      clientSecret: rotated.secret,
    });
  }
  if (action === 'item' && req.method === 'DELETE') {
    await deps.store.revokeClient(id, now(deps));
    await deps.audit.emit({
      eventType: 'assistant.client.revoked',
      org: tenant.org,
      app: tenant.app,
      env: tenant.env,
      decision: 'allow',
      status: 204,
      ...(identity ? { actorSubject: identity.subject } : {}),
      ...(identity?.email ? { actorEmail: identity.email } : {}),
      details: { clientId: id },
    });
    res.statusCode = 204;
    res.end();
    return;
  }
  sendJson(res, 405, { error: 'method not allowed' });
}

function publicClient(client: {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly deploymentId: string;
  readonly revokedAt?: string;
}) {
  return {
    id: client.id,
    name: client.name,
    createdAt: client.createdAt,
    // Audit data only: sessions follow the tenant's active deployment, not this snapshot.
    createdAgainstDeploymentId: client.deploymentId,
    ...(client.revokedAt ? { revokedAt: client.revokedAt } : {}),
  };
}

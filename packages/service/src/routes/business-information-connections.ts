import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import {
  ApplicationConnectionCallbackRequestSchema,
  ApplicationConnectionCallbackResponseSchema,
  ApplicationConnectionConnectRequestSchema,
  ApplicationConnectionConnectResponseSchema,
  ApplicationConnectionDisconnectRequestSchema,
  ApplicationConnectionsResponseSchema,
} from '@noodle-borg/wire-contracts';
import {
  businessGrantAllows,
  type SolutionInstallation,
} from '../business-information/portable.js';
import {
  type ApplicationConnections,
  ConnectionError,
  type ConnectionTarget,
} from '../connections/types.js';
import {
  type BusinessInformationRouteDeps,
  requireIdentity,
  requireInstallationPermission,
} from './business-information.js';
import type { SolutionInstallationRef } from './business-information-paths.js';

export interface BusinessConnectionRouteDeps extends BusinessInformationRouteDeps {
  readonly connections?: ApplicationConnections['connections'];
  readonly resolveConnectionTargets?: (
    installation: SolutionInstallation,
  ) => Promise<readonly ConnectionTarget[]>;
}
export async function handleApplicationConnections(
  req: IncomingMessage,
  res: ServerResponse,
  ref: SolutionInstallationRef,
  deps: BusinessConnectionRouteDeps,
): Promise<void> {
  const mutation = ref.connectionAction !== undefined;
  if (req.method !== (mutation ? 'POST' : 'GET')) {
    res.setHeader('allow', mutation ? 'POST' : 'GET');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  const authorized = await requireInstallationPermission(
    res,
    ref,
    identity,
    mutation ? 'installation:administer' : 'records:read',
    deps,
  );
  if (authorized === undefined) return;
  if (authorized.grant.role === 'viewer')
    return sendJson(res, 403, {
      code: 'connection_denied',
      error: 'Integration access requires an operator grant.',
    });
  res.setHeader('cache-control', 'private, no-store');
  if (!deps.connections || !deps.resolveConnectionTargets)
    return failure(res, new ConnectionError('connection_unavailable'));
  try {
    const targets = await deps.resolveConnectionTargets(authorized.installation);
    const connections = deps.connections;
    const projection = async () => ({
      connections: await Promise.all(targets.map((target) => connections.inspect(target))),
      canEdit: businessGrantAllows(authorized.grant, 'installation:administer'),
    });
    if (!mutation)
      return sendJson(
        res,
        200,
        ApplicationConnectionsResponseSchema.parse({ ok: true, data: await projection() }),
      );
    const target = targets.find((item) => item.key.connectionId === ref.connectionId);
    if (!target)
      return sendJson(res, 404, {
        code: 'connection_unavailable',
        error: 'Connection is unavailable.',
      });
    const body = await readJsonBody(req, Math.min(deps.maxBody, 16_384));
    if (!body.ok) return sendJson(res, body.status, { error: body.error });
    if (ref.connectionAction === 'connect') {
      const input = ApplicationConnectionConnectRequestSchema.safeParse(body.value);
      if (!input.success) return failure(res, new ConnectionError('connection_invalid'));
      const data = await connections.connect(target, input.data, identity.subject);
      return sendJson(
        res,
        200,
        ApplicationConnectionConnectResponseSchema.parse({ ok: true, data }),
      );
    }
    const input = ApplicationConnectionDisconnectRequestSchema.safeParse(body.value);
    if (!input.success) return failure(res, new ConnectionError('connection_invalid'));
    await connections.disconnect(target, input.data.expectedRevision, identity.subject);
    await deps.audit?.emit({
      eventType: 'config.connection.disconnected',
      org: authorized.scope.org,
      app: authorized.scope.app,
      env: authorized.scope.env,
      actorSubject: identity.subject,
      details: { connectionId: target.key.connectionId },
    });
    sendJson(
      res,
      200,
      ApplicationConnectionsResponseSchema.parse({ ok: true, data: await projection() }),
    );
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    failure(res, error);
  }
}
export async function handleApplicationConnectionCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BusinessConnectionRouteDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const identity = await requireIdentity(req, res, deps);
  if (identity === false) return;
  res.setHeader('cache-control', 'private, no-store');
  if (!deps.connections) return failure(res, new ConnectionError('connection_unavailable'));
  const body = await readJsonBody(req, Math.min(deps.maxBody, 16_384));
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const input = ApplicationConnectionCallbackRequestSchema.safeParse(body.value);
  if (!input.success) return failure(res, new ConnectionError('connection_invalid'));
  try {
    const data = await deps.connections.callback(input.data, identity.subject);
    sendJson(res, 200, ApplicationConnectionCallbackResponseSchema.parse({ ok: true, data }));
  } catch (error) {
    if (!(error instanceof ConnectionError)) throw error;
    failure(res, error);
  }
}
function failure(res: ServerResponse, error: ConnectionError): void {
  sendJson(
    res,
    error.code === 'connection_denied'
      ? 403
      : error.code === 'connection_conflict'
        ? 409
        : error.code === 'connection_unavailable'
          ? 503
          : 400,
    { code: error.code, error: 'Connection request could not be completed.' },
  );
}

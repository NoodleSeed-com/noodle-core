import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ControlPlaneIdentity, DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { createClientSecret, digestClientSecret } from '../oauth/service-principal-credentials.js';
import type { ServicePrincipalRuntime } from '../oauth/service-principal-store.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore } from '../store.js';
import { authorizeControlPlane } from './control-plane.js';
import {
  createServicePrincipalCredentialSchema,
  createServicePrincipalGrantSchema,
  createServicePrincipalSchema,
} from './service-principal-contracts.js';
import type { ServicePrincipalPath } from './service-principal-paths.js';

export interface ServicePrincipalRouteDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly registry: ServerRegistry;
  readonly runtime: ServicePrincipalRuntime;
  readonly audit: AuditSink;
  readonly maxBody: number;
}

export async function handleServicePrincipalRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: ServicePrincipalPath,
  deps: ServicePrincipalRouteDeps,
): Promise<void> {
  const identity = await authorizeHumanOrgMember(req, res, path.org, deps);
  if (identity === false) return;
  if (!deps.runtime.ready) {
    return sendJson(res, 503, { error: 'service_principals_unavailable' });
  }
  const store = deps.runtime.store;

  if (path.kind === 'collection' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, data: await store.listPrincipals(path.org) });
  }
  if (path.kind === 'collection' && req.method === 'POST') {
    const input = await parseBody(req, res, deps.maxBody, createServicePrincipalSchema);
    if (input === undefined) return;
    const created = await store.createPrincipal({
      org: path.org,
      name: input.name,
      actorSubject: identity.subject,
    });
    await emit(deps.audit, 'service_principal.created', identity, path.org, {
      principalId: created.principalId,
    });
    return sendJson(res, 201, { ok: true, data: created });
  }
  if (path.kind === 'principal' && req.method === 'GET') {
    const view = await store.getPrincipal(path);
    return view === undefined
      ? sendJson(res, 404, { error: 'not found' })
      : sendJson(res, 200, { ok: true, data: view });
  }
  if (path.kind === 'principal' && req.method === 'DELETE') {
    if ((await store.getPrincipal(path)) === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    await store.revokePrincipal({ ...path, actorSubject: identity.subject });
    await emit(deps.audit, 'service_principal.revoked', identity, path.org, {
      principalId: path.principalId,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (path.kind === 'grants' && req.method === 'POST') {
    if ((await store.getPrincipal(path)) === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const input = await parseBody(req, res, deps.maxBody, createServicePrincipalGrantSchema);
    if (input === undefined) return;
    if (
      (await deps.registry.getEnvironment(path.org, input.app, input.environment)) === undefined
    ) {
      return sendJson(res, 404, { error: 'not found' });
    }
    try {
      const grant = await store.createGrant({
        principalId: path.principalId,
        org: path.org,
        app: input.app,
        environment: input.environment,
        scopes: input.scopes,
        actorSubject: identity.subject,
      });
      await emit(deps.audit, 'service_principal.grant.created', identity, path.org, {
        principalId: path.principalId,
        grantId: grant.grantId,
        app: grant.app,
        environment: grant.environment,
      });
      return sendJson(res, 201, { ok: true, data: grant });
    } catch (error) {
      return sendJson(res, 400, { error: safeMutationError(error) });
    }
  }
  if (path.kind === 'grant' && req.method === 'DELETE') {
    if ((await store.getPrincipal(path)) === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const revoked = await store.revokeGrant({ ...path, actorSubject: identity.subject });
    if (!revoked) return sendJson(res, 404, { error: 'not found' });
    await emit(deps.audit, 'service_principal.grant.revoked', identity, path.org, {
      principalId: path.principalId,
      grantId: path.grantId,
    });
    return sendJson(res, 200, { ok: true });
  }
  if (path.kind === 'credentials' && req.method === 'POST') {
    if ((await store.getPrincipal(path)) === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const input = await parseBody(req, res, deps.maxBody, createServicePrincipalCredentialSchema);
    if (input === undefined) return;
    try {
      if (input.kind === 'client_secret') {
        const secret = createClientSecret();
        const credential = await store.createCredential({
          principalId: path.principalId,
          org: path.org,
          actorSubject: identity.subject,
          kind: input.kind,
          label: input.label,
          secretDigest: digestClientSecret(secret),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        });
        await credentialAudit(deps.audit, identity, path.org, credential);
        return sendJson(res, 201, { ok: true, data: { ...credential, secret } });
      }
      const credential = await store.createCredential({
        principalId: path.principalId,
        org: path.org,
        actorSubject: identity.subject,
        kind: input.kind,
        label: input.label,
        algorithm: input.algorithm,
        publicJwk: input.publicJwk,
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      });
      await credentialAudit(deps.audit, identity, path.org, credential);
      return sendJson(res, 201, { ok: true, data: credential });
    } catch (error) {
      return sendJson(res, 400, { error: safeMutationError(error) });
    }
  }
  if (path.kind === 'credential' && req.method === 'DELETE') {
    if ((await store.getPrincipal(path)) === undefined) {
      return sendJson(res, 404, { error: 'not found' });
    }
    const revoked = await store.revokeCredential({ ...path, actorSubject: identity.subject });
    if (!revoked) return sendJson(res, 404, { error: 'not found' });
    await emit(deps.audit, 'service_principal.credential.revoked', identity, path.org, {
      principalId: path.principalId,
      credentialId: path.credentialId,
    });
    return sendJson(res, 200, { ok: true });
  }
  res.setHeader('allow', allowedMethods(path.kind).join(', '));
  return sendJson(res, 405, { error: 'method not allowed' });
}

async function authorizeHumanOrgMember(
  req: IncomingMessage,
  res: ServerResponse,
  org: string,
  deps: ServicePrincipalRouteDeps,
): Promise<ControlPlaneIdentity | false> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return false;
  if (
    !identity.superAdmin &&
    !(await deps.controlPlane.isOrgMember({ org, subject: identity.subject }))
  ) {
    sendJson(res, 404, { error: 'not found' });
    return false;
  }
  return identity;
}

async function parseBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  maxBody: number,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T | undefined> {
  const body = await readJsonBody(req, maxBody);
  if (!body.ok) {
    sendJson(res, body.status, { error: body.error });
    return undefined;
  }
  const parsed = schema.safeParse(body.value);
  if (!parsed.success) {
    sendJson(res, 400, { error: 'invalid service-principal request' });
    return undefined;
  }
  return parsed.data;
}

async function credentialAudit(
  audit: AuditSink,
  identity: ControlPlaneIdentity,
  org: string,
  credential: {
    readonly principalId: string;
    readonly credentialId: string;
    readonly kind: string;
  },
): Promise<void> {
  await emit(audit, 'service_principal.credential.created', identity, org, {
    principalId: credential.principalId,
    credentialId: credential.credentialId,
    kind: credential.kind,
  });
}

function emit(
  audit: AuditSink,
  eventType: string,
  identity: ControlPlaneIdentity,
  org: string,
  details: Readonly<Record<string, string>>,
): Promise<void> {
  return audit.emit({
    eventType,
    org,
    actorSubject: identity.subject,
    actorEmail: identity.email,
    decision: 'allow',
    status: 200,
    details,
  });
}

function allowedMethods(kind: ServicePrincipalPath['kind']): readonly string[] {
  if (kind === 'collection') return ['GET', 'POST'];
  if (kind === 'principal') return ['GET', 'DELETE'];
  if (kind === 'grants' || kind === 'credentials') return ['POST'];
  return ['DELETE'];
}

function safeMutationError(error: unknown): string {
  if (!(error instanceof Error)) return 'invalid service-principal request';
  return /^(service principal|service-principal|public JWK)/.test(error.message)
    ? error.message
    : 'invalid service-principal request';
}

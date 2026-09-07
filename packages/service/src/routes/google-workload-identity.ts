import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { sendJson } from '@noodle-borg/transport-http';
import type {
  GoogleWorkloadIdentityStore,
  StoredGoogleWorkloadIdentity,
} from '../google-workload-identity-store.js';
import type { ServerRegistry } from '../registry.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { authorizeTenantControl } from './control-plane.js';

export interface GoogleWorkloadIdentityRouteDeps {
  readonly store: GoogleWorkloadIdentityStore;
  readonly issuer: string;
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly audit: AuditSink;
}

export async function handleGoogleWorkloadIdentityDoctor(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  deps: Pick<GoogleWorkloadIdentityRouteDeps, 'gate' | 'controlPlane'> & {
    readonly registry: ServerRegistry;
  },
): Promise<void> {
  const identity = await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, tenant.org);
  if (identity === false) return;
  const target = await deps.registry.getActiveByTenant(tenant);
  if (target === undefined) {
    return sendJson(res, 404, { ok: false, error: 'deployment not found' });
  }
  const probe = target.served.deps.broker.probeServiceCredentials;
  if (probe === undefined) {
    return sendJson(res, 409, {
      ok: false,
      error: 'deployment credential broker does not support service diagnostics',
    });
  }
  const checks = await probe.call(target.served.deps.broker);
  return sendJson(res, 200, {
    ok: checks.every((check) => check.ok),
    checks,
  });
}

/** Owner/member-gated environment lifecycle for the platform identity trusted by Google WIF. */
export async function handleGoogleWorkloadIdentity(
  req: IncomingMessage,
  res: ServerResponse,
  tenant: TenantRef,
  deps: GoogleWorkloadIdentityRouteDeps,
): Promise<void> {
  const identity = await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, tenant.org);
  if (identity === false) return;
  const issuer = normalizeIssuer(deps.issuer);
  if (req.method === 'GET') {
    const record = await deps.store.get(tenant);
    if (record === undefined) {
      return sendJson(res, 404, {
        error: 'Google workload identity is not prepared for this environment',
      });
    }
    return sendJson(res, 200, response(record, issuer));
  }
  if (req.method === 'PUT') {
    const record = await deps.store.prepare({
      ...tenant,
      actorSubject: identity.subject,
      ...(identity.email === undefined ? {} : { actorEmail: identity.email }),
    });
    await emitLifecycleAudit(deps.audit, 'google_workload_identity.prepared', tenant, identity);
    return sendJson(res, 200, response(record, issuer));
  }
  if (req.method === 'DELETE') {
    const record = await deps.store.revoke({
      ...tenant,
      actorSubject: identity.subject,
      ...(identity.email === undefined ? {} : { actorEmail: identity.email }),
    });
    if (record === undefined) {
      return sendJson(res, 404, {
        error: 'Google workload identity is not prepared for this environment',
      });
    }
    await emitLifecycleAudit(deps.audit, 'google_workload_identity.revoked', tenant, identity);
    return sendJson(res, 200, response(record, issuer));
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

function response(record: StoredGoogleWorkloadIdentity, issuer: string): Record<string, unknown> {
  return {
    ok: true,
    data: {
      status: record.active ? 'active' : 'revoked',
      subject: record.subject,
      issuer,
      oidcDiscoveryUrl: `${issuer}/.well-known/openid-configuration`,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.tenant_id': 'assertion.tenant_id',
      },
      attributeCondition: `assertion.tenant_id == '${record.tenantId}'`,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
  };
}

function emitLifecycleAudit(
  audit: AuditSink,
  eventType: string,
  tenant: TenantRef,
  actor: { readonly subject: string; readonly email?: string },
): Promise<void> {
  return audit.emit({
    eventType,
    org: tenant.org,
    app: tenant.app,
    env: tenant.env,
    actorSubject: actor.subject,
    ...(actor.email === undefined ? {} : { actorEmail: actor.email }),
  });
}

function normalizeIssuer(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Google workload identity issuer must be an HTTPS origin');
  }
  return url.origin;
}

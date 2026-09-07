import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryGoogleWorkloadIdentityStore } from '../src/google-workload-identity-store.js';
import type { ServerRegistry } from '../src/registry.js';
import {
  handleGoogleWorkloadIdentity,
  handleGoogleWorkloadIdentityDoctor,
} from '../src/routes/google-workload-identity.js';
import type { AuditSink } from '../src/store/audit.js';
import type { ControlPlaneStore } from '../src/store.js';

const tenant = { org: 'acme', app: 'analytics', env: 'prod' };
const gate = {
  authorize: vi.fn(async () => ({
    ok: true as const,
    identity: { subject: 'owner-1', email: 'owner@example.com' },
  })),
} satisfies DeployAuthGate;
const controlPlane = {
  isOrgMember: vi.fn(async () => true),
} as unknown as ControlPlaneStore;

describe('Google workload identity lifecycle route', () => {
  it('prepares and reads the exact operator-facing OIDC configuration', async () => {
    const store = new InMemoryGoogleWorkloadIdentityStore({
      randomId: () => 'identity-1',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    const audit = { emit: vi.fn(async () => undefined) } satisfies AuditSink;
    const prepared = captureResponse();

    await handleGoogleWorkloadIdentity(
      { method: 'PUT', headers: {} } as IncomingMessage,
      prepared.res,
      tenant,
      { store, issuer: 'https://cloud.noodleseed.dev', gate, controlPlane, audit },
    );

    expect(prepared.status()).toBe(200);
    expect(prepared.body()).toEqual({
      ok: true,
      data: {
        status: 'active',
        subject: 'noodle:google-workload:identity-1',
        issuer: 'https://cloud.noodleseed.dev',
        oidcDiscoveryUrl: 'https://cloud.noodleseed.dev/.well-known/openid-configuration',
        jwksUrl: 'https://cloud.noodleseed.dev/.well-known/jwks.json',
        attributeMapping: {
          'google.subject': 'assertion.sub',
          'attribute.tenant_id': 'assertion.tenant_id',
        },
        attributeCondition: "assertion.tenant_id == 'acme/analytics/prod'",
        createdAt: '2026-07-23T12:00:00.000Z',
        updatedAt: '2026-07-23T12:00:00.000Z',
      },
    });
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'google_workload_identity.prepared',
        org: 'acme',
        app: 'analytics',
        env: 'prod',
        actorSubject: 'owner-1',
      }),
    );

    const read = captureResponse();
    await handleGoogleWorkloadIdentity(
      { method: 'GET', headers: {} } as IncomingMessage,
      read.res,
      tenant,
      { store, issuer: 'https://cloud.noodleseed.dev', gate, controlPlane, audit },
    );
    expect(read.body()).toEqual(prepared.body());
  });

  it('revokes idempotently and reports the inactive status without exposing internal revisions', async () => {
    const store = new InMemoryGoogleWorkloadIdentityStore({
      randomId: () => 'identity-1',
      now: () => new Date('2026-07-23T12:00:00.000Z'),
    });
    await store.prepare({ ...tenant, actorSubject: 'owner-1' });
    const audit = { emit: vi.fn(async () => undefined) } satisfies AuditSink;
    const response = captureResponse();

    await handleGoogleWorkloadIdentity(
      { method: 'DELETE', headers: {} } as IncomingMessage,
      response.res,
      tenant,
      { store, issuer: 'https://cloud.noodleseed.dev', gate, controlPlane, audit },
    );

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      ok: true,
      data: {
        status: 'revoked',
        subject: 'noodle:google-workload:identity-1',
      },
    });
    expect(response.body()).not.toHaveProperty('data.revision');
    expect(audit.emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'google_workload_identity.revoked' }),
    );
  });

  it('requires an authorized organization member before reading or mutating identity state', async () => {
    const store = new InMemoryGoogleWorkloadIdentityStore();
    const deniedControlPlane = {
      isOrgMember: vi.fn(async () => false),
    } as unknown as ControlPlaneStore;
    const response = captureResponse();

    await handleGoogleWorkloadIdentity(
      { method: 'PUT', headers: {} } as IncomingMessage,
      response.res,
      tenant,
      {
        store,
        issuer: 'https://cloud.noodleseed.dev',
        gate,
        controlPlane: deniedControlPlane,
        audit: { emit: vi.fn(async () => undefined) },
      },
    );

    expect(response.status()).toBe(403);
    await expect(store.get(tenant)).resolves.toBeUndefined();
  });

  it('runs a live service-credential exchange without invoking a business operation', async () => {
    const probe = vi.fn(async () => [
      {
        connectorId: 'bigquery',
        operation: 'query',
        authKind: 'googleWorkloadIdentity' as const,
        ok: true,
      },
    ]);
    const registry = {
      getActiveByTenant: vi.fn(async () => ({
        served: { deps: { broker: { getCredential: vi.fn(), probeServiceCredentials: probe } } },
      })),
    } as unknown as ServerRegistry;
    const response = captureResponse();

    await handleGoogleWorkloadIdentityDoctor(
      { method: 'POST', headers: {} } as IncomingMessage,
      response.res,
      tenant,
      { registry, gate, controlPlane },
    );

    expect(response.status()).toBe(200);
    expect(response.body()).toMatchObject({
      ok: true,
      checks: [{ connectorId: 'bigquery', authKind: 'googleWorkloadIdentity', ok: true }],
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

function captureResponse(): {
  readonly res: ServerResponse;
  readonly status: () => number | undefined;
  readonly body: () => Record<string, unknown>;
} {
  let status: number | undefined;
  let body = '';
  return {
    res: {
      writeHead(code: number) {
        status = code;
        return this;
      },
      end(chunk?: string) {
        body = chunk ?? '';
        return this;
      },
    } as unknown as ServerResponse,
    status: () => status,
    body: () => JSON.parse(body) as Record<string, unknown>,
  };
}

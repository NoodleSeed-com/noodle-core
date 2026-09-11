import { accessUpdateResponseSchema } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ControlPlaneIdentity,
  type DeployAuthGate,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  type RunningService,
  serveService,
  type TenantRef,
} from '../src/index.js';

const TENANT = { org: 'acme', app: 'support-agent', env: 'prod' } as const;
const OWNER = {
  subject: 'user_owner',
  email: 'owner@acme.test',
  superAdmin: false,
} as const;
const MEMBER = {
  subject: 'user_member',
  email: 'member@acme.test',
  superAdmin: false,
} as const;
const SUPERADMIN = {
  subject: 'user_admin',
  email: 'admin@noodleseed.test',
  superAdmin: true,
} as const;

let service: RunningService;
let audit: InMemoryAuditStore;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  audit = new InMemoryAuditStore();
  await controlPlane.createOrg({ slug: TENANT.org, displayName: 'Acme' });
  await controlPlane.addOrgMember({
    org: TENANT.org,
    subject: OWNER.subject,
    email: OWNER.email,
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: TENANT.org,
    subject: MEMBER.subject,
    email: MEMBER.email,
    role: 'developer',
  });
  service = await serveService({
    port: 0,
    controlPlaneStore: controlPlane,
    deployGate: authGate(),
    audit,
  });
});

afterEach(async () => {
  await service.close();
});

describe('PATCH tenant deployment access', () => {
  it('rejects missing and invalid bearer authentication before reading the request', async () => {
    for (const token of [null, 'invalid-token']) {
      const response = await updateAccess(TENANT, { accessMode: 'public' }, token);
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 401,
        body: { error: 'valid bearer token required' },
      });
    }
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it('requires an organization owner and keeps the active access mode unchanged', async () => {
    await deploy(TENANT, 'org-members');

    const response = await updateAccess(TENANT, { accessMode: 'authenticated' }, 'member-token');

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Only an organization owner can change environment access.',
      code: 'organization_owner_required',
    });
    await expect(service.registry.activeDeployProvenance(TENANT)).resolves.toMatchObject({
      accessMode: 'org-members',
    });
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it('lets an organization owner update the active environment and emits a safe audit event', async () => {
    const deploymentId = await deploy(TENANT, 'org-members');

    const response = await updateAccess(TENANT, {
      accessMode: 'authenticated',
      serverVersion: '1',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      target: TENANT,
      deployment: {
        deploymentId,
        serverVersion: '1',
        accessMode: 'authenticated',
        authentication: 'platform',
        ownerSubject: OWNER.subject,
      },
      previousAccessMode: 'org-members',
      previousOwnerSubject: OWNER.subject,
      accessChanged: true,
      ownerChanged: false,
      policyChanged: false,
      changed: true,
    });
    await expect(accessEvents()).resolves.toContainEqual(
      expect.objectContaining({
        eventType: 'deployment.access.updated',
        actorSubject: OWNER.subject,
        org: TENANT.org,
        app: TENANT.app,
        env: TENANT.env,
        deploymentId,
        decision: 'allow',
        status: '200',
        details: {
          previousAccessMode: 'org-members',
          accessMode: 'authenticated',
          previousOwnerSubject: OWNER.subject,
          ownerSubject: OWNER.subject,
          accessChanged: true,
          ownerChanged: false,
          authentication: 'platform',
          policyChanged: false,
          changed: true,
        },
      }),
    );
  });

  it('returns a schema-valid ownerless legacy response when public access becomes authenticated', async () => {
    const target = { ...TENANT, app: 'legacy-ownerless-authenticated' };
    const deploymentId = await deploy(
      target,
      'public',
      basicManifest(target.app.replaceAll('-', '_')),
      null,
    );

    const response = await updateAccess(target, { accessMode: 'authenticated' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      target,
      deployment: {
        deploymentId,
        serverVersion: '1',
        accessMode: 'authenticated',
        authentication: 'platform',
      },
      previousAccessMode: 'public',
      accessChanged: true,
      ownerChanged: false,
      policyChanged: false,
      changed: true,
    });
    expect(accessUpdateResponseSchema.safeParse(body).success).toBe(true);
  });

  it('returns a schema-valid explicit owner when ownerless legacy public access becomes owner-only', async () => {
    const target = { ...TENANT, app: 'legacy-ownerless-owner-only' };
    const deploymentId = await deploy(
      target,
      'public',
      basicManifest(target.app.replaceAll('-', '_')),
      null,
    );

    const response = await updateAccess(target, {
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human-2',
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      target,
      deployment: {
        deploymentId,
        serverVersion: '1',
        accessMode: 'owner-only',
        authentication: 'platform',
        ownerSubject: 'oauth-human-2',
      },
      previousAccessMode: 'public',
      accessChanged: true,
      ownerChanged: true,
      policyChanged: false,
      changed: true,
    });
    expect(accessUpdateResponseSchema.safeParse(body).success).toBe(true);
  });

  it('lets a superadmin update access without an organization membership row', async () => {
    const target = { ...TENANT, app: 'admin-managed' };
    await deploy(target, 'owner-only');

    const response = await updateAccess(target, { accessMode: 'public' }, 'admin-token');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      target,
      previousAccessMode: 'owner-only',
      previousOwnerSubject: OWNER.subject,
      accessChanged: true,
      ownerChanged: false,
      changed: true,
      deployment: { accessMode: 'public', ownerSubject: OWNER.subject },
    });
    await expect(accessEvents()).resolves.toContainEqual(
      expect.objectContaining({
        eventType: 'deployment.access.updated',
        actorSubject: SUPERADMIN.subject,
        app: target.app,
      }),
    );
  });

  it.each([
    ['unknown fields', { accessMode: 'public', unexpected: true }],
    ['unsupported access modes', { accessMode: 'caller-key' }],
    ['invalid server versions', { accessMode: 'public', serverVersion: 'not/a/version' }],
  ])('rejects %s with 400 without changing state', async (_label, body) => {
    await deploy(TENANT, 'owner-only');

    const response = await updateAccess(TENANT, body);

    expect(response.status).toBe(400);
    await expect(service.registry.activeDeployProvenance(TENANT)).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it('maps a missing active deployment to its typed 404 response', async () => {
    const response = await updateAccess(TENANT, { accessMode: 'public' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'No active deployment exists for this environment.',
      code: 'no_active_deployment',
    });
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it.each([
    {
      app: 'no-customer-auth',
      current: 'owner-only' as const,
      next: 'customers' as const,
      code: 'server_auth_required',
      manifest: basicManifest('no_customer_auth'),
    },
    {
      app: 'user-context',
      current: 'owner-only' as const,
      next: 'public' as const,
      code: 'public_user_context_conflict',
      manifest: userManifest(),
    },
    {
      app: 'ownerless',
      current: 'public' as const,
      next: 'owner-only' as const,
      code: 'owner_identity_required',
      manifest: basicManifest('ownerless'),
      actor: null,
    },
  ])('maps $code to 409 and preserves the old mode', async (testCase) => {
    const target = { ...TENANT, app: testCase.app };
    await deploy(target, testCase.current, testCase.manifest, testCase.actor);

    const response = await updateAccess(target, { accessMode: testCase.next });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: testCase.code });
    await expect(service.registry.activeDeployProvenance(target)).resolves.toMatchObject({
      accessMode: testCase.current,
    });
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it('maps an access-update conflict to 409 without changing state or auditing', async () => {
    await deploy(TENANT, 'owner-only');
    vi.spyOn(service.registry, 'updateAccess').mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: 'access_update_conflict',
      message: 'The active deployment changed before access could be updated.',
    });

    const response = await updateAccess(TENANT, { accessMode: 'authenticated' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'The active deployment changed before access could be updated.',
      code: 'access_update_conflict',
    });
    await expect(service.registry.activeDeployProvenance(TENANT)).resolves.toMatchObject({
      accessMode: 'owner-only',
    });
    await expect(accessEvents()).resolves.toEqual([]);
  });

  it('audits a successful no-op exactly once with changed false', async () => {
    const deploymentId = await deploy(TENANT, 'authenticated');

    const response = await updateAccess(TENANT, { accessMode: 'authenticated' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      previousAccessMode: 'authenticated',
      previousOwnerSubject: OWNER.subject,
      accessChanged: false,
      ownerChanged: false,
      changed: false,
      deployment: {
        deploymentId,
        accessMode: 'authenticated',
        ownerSubject: OWNER.subject,
      },
    });
    await expect(accessEvents()).resolves.toEqual([
      expect.objectContaining({
        eventType: 'deployment.access.updated',
        deploymentId,
        details: {
          previousAccessMode: 'authenticated',
          accessMode: 'authenticated',
          previousOwnerSubject: OWNER.subject,
          ownerSubject: OWNER.subject,
          accessChanged: false,
          ownerChanged: false,
          authentication: 'platform',
          policyChanged: false,
          changed: false,
        },
      }),
    ]);
  });

  it('atomically transfers only the owner and audits the real operator with component flags', async () => {
    const deploymentId = await deploy(TENANT, 'owner-only');

    const response = await updateAccess(TENANT, {
      accessMode: 'owner-only',
      ownerSubject: 'oauth-human-2',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      target: TENANT,
      deployment: {
        deploymentId,
        serverVersion: '1',
        accessMode: 'owner-only',
        authentication: 'platform',
        ownerSubject: 'oauth-human-2',
      },
      previousAccessMode: 'owner-only',
      previousOwnerSubject: OWNER.subject,
      accessChanged: false,
      ownerChanged: true,
      policyChanged: false,
      changed: true,
    });
    await expect(accessEvents()).resolves.toEqual([
      expect.objectContaining({
        eventType: 'deployment.access.updated',
        actorSubject: OWNER.subject,
        deploymentId,
        details: {
          previousAccessMode: 'owner-only',
          accessMode: 'owner-only',
          previousOwnerSubject: OWNER.subject,
          ownerSubject: 'oauth-human-2',
          accessChanged: false,
          ownerChanged: true,
          authentication: 'platform',
          policyChanged: false,
          changed: true,
        },
      }),
    ]);
  });

  it('reports an exact owner-only no-op without rewriting creator provenance', async () => {
    const deploymentId = await deploy(TENANT, 'owner-only');

    const response = await updateAccess(TENANT, {
      accessMode: 'owner-only',
      ownerSubject: OWNER.subject,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deployment: { deploymentId, ownerSubject: OWNER.subject },
      previousOwnerSubject: OWNER.subject,
      accessChanged: false,
      ownerChanged: false,
      changed: false,
    });
    await expect(service.registry.getDeployment(TENANT.org, deploymentId)).resolves.toMatchObject({
      ownerSubject: OWNER.subject,
    });
  });
});

function authGate(): DeployAuthGate {
  const identities = new Map<string, ControlPlaneIdentity>([
    ['owner-token', OWNER],
    ['member-token', MEMBER],
    ['admin-token', SUPERADMIN],
  ]);
  return {
    authorize: (req) => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const identity = token === undefined ? undefined : identities.get(token);
      return identity === undefined
        ? { ok: false, status: 401, message: 'valid bearer token required' }
        : { ok: true, identity };
    },
  };
}

async function deploy(
  target: TenantRef,
  accessMode: 'owner-only' | 'org-members' | 'authenticated' | 'public',
  manifest = basicManifest(target.app.replaceAll('-', '_')),
  actor: ControlPlaneIdentity | null = OWNER,
): Promise<string> {
  const result = await service.registry.deploy(target, manifest, {
    accessMode,
    ...(actor === null ? {} : { actor }),
    serverVersion: '1',
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('test deployment failed');
  return result.deploymentId;
}

function updateAccess(
  target: TenantRef,
  body: unknown,
  token: string | null = 'owner-token',
): Promise<Response> {
  return fetch(
    `${service.url}/v1/orgs/${target.org}/apps/${target.app}/envs/${target.env}/access`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify(body),
    },
  );
}

async function accessEvents() {
  return (await audit.list({ org: TENANT.org })).filter(
    (event) => event.eventType === 'deployment.access.updated',
  );
}

function basicManifest(name: string): string {
  return JSON.stringify({
    manifestVersion: '1',
    server: { name, version: '1.0.0', title: 'Support' },
    tools: [
      {
        name: 'status',
        description: 'Return the service status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}

function userManifest(): string {
  return `
manifestVersion: "1"
server:
  name: user_context
  version: 1.0.0
  title: User context
tools:
  - name: whoami
    description: Return the caller identity.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    fulfilment:
      steps: []
      output:
        subject: \${user.subject}
`;
}

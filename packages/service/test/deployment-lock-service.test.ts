import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuditSink,
  type ControlPlaneIdentity,
  type DeployAuthGate,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  type RunningService,
  serveService,
  type TenantRef,
} from '../src/index.js';

const TENANT = { org: 'acme', app: 'submitted-server', env: 'prod' } as const;
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
  subject: 'platform_admin',
  email: 'admin@noodleseed.test',
  superAdmin: true,
} as const;

let service: RunningService;
let audit: InMemoryAuditStore;
let failAudit = false;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  audit = new InMemoryAuditStore();
  failAudit = false;
  const guardedAudit: AuditSink = {
    emit: (event) => {
      if (failAudit) return Promise.reject(new Error('audit unavailable'));
      return audit.emit(event);
    },
  };
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
    audit: guardedAudit,
  });
});

afterEach(async () => {
  await service.close();
});

describe('deployed server-version locks', () => {
  it('requires an owner and an exact active deployment before locking', async () => {
    const deploymentId = await deploy(TENANT);

    expect(
      (
        await updateLock(
          { serverVersion: '1', expectedDeploymentId: deploymentId, locked: true },
          null,
        )
      ).status,
    ).toBe(401);

    const forbidden = await updateLock(
      { serverVersion: '1', expectedDeploymentId: deploymentId, locked: true },
      'member-token',
    );
    expect(forbidden.status).toBe(403);
    await expect(forbidden.json()).resolves.toMatchObject({
      code: 'organization_owner_required',
    });

    const stale = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: 'dep_stale',
      locked: true,
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: 'deployment_lock_conflict' });

    const missing = await updateLock(
      {
        serverVersion: '1',
        expectedDeploymentId: deploymentId,
        locked: true,
      },
      'owner-token',
      { ...TENANT, env: 'missing' },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: 'no_active_deployment' });
    await expect(lockEvents()).resolves.toEqual([]);
  });

  it('locks idempotently, exposes only safe metadata, and unlocks idempotently', async () => {
    const deploymentId = await deploy(TENANT);

    const locked = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: true,
    });
    expect(locked.status).toBe(200);
    const lockedBody = (await locked.json()) as Record<string, unknown>;
    expect(lockedBody).toMatchObject({
      ok: true,
      target: TENANT,
      deployment: {
        deploymentId,
        serverVersion: '1',
        locked: true,
        deploymentLock: {
          lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          lockedByEmail: OWNER.email,
        },
      },
      changed: true,
      auditRecorded: true,
    });
    expect(JSON.stringify(lockedBody)).not.toContain(OWNER.subject);

    const repeat = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: true,
    });
    await expect(repeat.json()).resolves.toMatchObject({ changed: false });

    await expect(service.registry.getStatus(TENANT, service.url, '1')).resolves.toMatchObject({
      deployment: {
        deploymentId,
        deploymentLock: { lockedByEmail: OWNER.email },
      },
    });
    const [summary] = await service.registry.listDeployments({ org: TENANT.org });
    expect(summary).toMatchObject({
      deploymentId,
      ownerSubject: OWNER.subject,
      deploymentLock: { lockedByEmail: OWNER.email },
    });
    expect(summary?.deploymentLock).not.toHaveProperty('lockedBySubject');

    const unlocked = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: false,
    });
    await expect(unlocked.json()).resolves.toMatchObject({
      deployment: { deploymentId, serverVersion: '1', locked: false },
      changed: true,
    });
    const repeatedUnlock = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: false,
    });
    await expect(repeatedUnlock.json()).resolves.toMatchObject({ changed: false });

    const events = await lockEvents();
    expect(events).toHaveLength(4);
    expect(events).toContainEqual(
      expect.objectContaining({
        eventType: 'deployment.lock.updated',
        deploymentId,
        actorSubject: OWNER.subject,
        details: { serverVersion: '1', locked: true, changed: true },
      }),
    );
  });

  it('allows a superadmin to mutate while an authenticated member can read safe lock state', async () => {
    const deploymentId = await deploy(TENANT);
    const locked = await updateLock(
      { serverVersion: '1', expectedDeploymentId: deploymentId, locked: true },
      'superadmin-token',
    );
    expect(locked.status).toBe(200);

    const visible = await fetch(`${service.url}${targetPath(TENANT)}/status?version=1`, {
      headers: { authorization: 'Bearer member-token' },
    });
    expect(visible.status).toBe(200);
    const body = (await visible.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      deployment: {
        deploymentId,
        deploymentLock: { lockedByEmail: SUPERADMIN.email },
      },
    });
    expect(JSON.stringify(body)).not.toContain(SUPERADMIN.subject);

    const unlocked = await updateLock(
      { serverVersion: '1', expectedDeploymentId: deploymentId, locked: false },
      'superadmin-token',
    );
    await expect(unlocked.json()).resolves.toMatchObject({ deployment: { locked: false } });
  });

  it('returns committed success and exposes audit degradation when evidence cannot be saved', async () => {
    const deploymentId = await deploy(TENANT);
    failAudit = true;

    const response = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: true,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changed: true,
      auditRecorded: false,
      deployment: { deploymentId, locked: true },
    });
    await expect(service.registry.getStatus(TENANT, service.url, '1')).resolves.toMatchObject({
      deployment: { deploymentId, deploymentLock: expect.anything() },
    });

    failAudit = false;
    const retry = await updateLock({
      serverVersion: '1',
      expectedDeploymentId: deploymentId,
      locked: true,
    });
    await expect(retry.json()).resolves.toMatchObject({
      changed: false,
      auditRecorded: true,
    });
    await expect(lockEvents()).resolves.toHaveLength(1);
  });

  it('rejects unknown fields and unversioned lock requests without changing state', async () => {
    const deploymentId = await deploy(TENANT);

    for (const body of [
      { serverVersion: '1', expectedDeploymentId: deploymentId, locked: true, extra: true },
      { serverVersion: 'not/a/version', expectedDeploymentId: deploymentId, locked: true },
      { expectedDeploymentId: deploymentId, locked: true },
    ]) {
      const response = await updateLock(body);
      expect(response.status).toBe(400);
    }

    await expect(service.registry.getStatus(TENANT, service.url, '1')).resolves.not.toMatchObject({
      deployment: { deploymentLock: expect.anything() },
    });
    await expect(lockEvents()).resolves.toEqual([]);
  });

  it('fails preflight before deploy, rejects final persistence, and audits the denial', async () => {
    const deploymentId = await deploy(TENANT);
    await lock(deploymentId);

    const preflight = await deployRequest('deploy/preflight');
    expect(preflight.status).toBe(200);
    await expect(preflight.json()).resolves.toMatchObject({
      ready: false,
      config: { ready: true },
      errors: [expect.objectContaining({ code: 'deployment_locked', path: 'serverVersion' })],
    });

    const final = await deployRequest('deploy');
    expect(final.status).toBe(409);
    await expect(final.json()).resolves.toMatchObject({
      ok: false,
      code: 'deployment_locked',
    });
    expect(await service.registry.listDeployments({ org: TENANT.org })).toHaveLength(1);
    await expect(audit.list({ org: TENANT.org })).resolves.toContainEqual(
      expect.objectContaining({
        eventType: 'deploy.rejected',
        reasonCode: 'deployment_locked',
        status: '409',
      }),
    );
  });

  it('blocks rollback pointer changes until the version is unlocked', async () => {
    const previousDeploymentId = await deploy(TENANT);
    const currentDeploymentId = await deploy(TENANT);
    await lock(currentDeploymentId);

    const blocked = await rollback(previousDeploymentId);
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      ok: false,
      code: 'deployment_locked',
    });
    await expect(audit.list({ org: TENANT.org })).resolves.toContainEqual(
      expect.objectContaining({
        eventType: 'rollback.rejected',
        reasonCode: 'deployment_locked',
      }),
    );

    await updateLock({
      serverVersion: '1',
      expectedDeploymentId: currentDeploymentId,
      locked: false,
    });
    const restored = await rollback(previousDeploymentId);
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      ok: true,
      rollback: { deploymentId: previousDeploymentId },
    });
  });
});

function authGate(): DeployAuthGate {
  const identities = new Map<string, ControlPlaneIdentity>([
    ['owner-token', OWNER],
    ['member-token', MEMBER],
    ['superadmin-token', SUPERADMIN],
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

async function deploy(target: TenantRef): Promise<string> {
  const result = await service.registry.deploy(target, manifest(), {
    actor: OWNER,
    accessMode: 'owner-only',
    serverVersion: '1',
  });
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error('test deployment failed');
  return result.deploymentId;
}

async function lock(expectedDeploymentId: string): Promise<void> {
  const response = await updateLock({ serverVersion: '1', expectedDeploymentId, locked: true });
  expect(response.status).toBe(200);
}

function updateLock(
  body: unknown,
  token: string | null = 'owner-token',
  target: TenantRef = TENANT,
): Promise<Response> {
  return fetch(`${service.url}${targetPath(target)}/deployment-lock`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

function deployRequest(action: 'deploy/preflight' | 'deploy'): Promise<Response> {
  const requestBody = JSON.stringify({
    manifest: manifest(),
    accessMode: 'owner-only',
    serverVersion: '1',
    deploymentSource: 'cli',
  });
  return fetch(`${service.url}${targetPath(TENANT)}/${action}`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
      ...(action === 'deploy'
        ? {
            'idempotency-key': `sha256:${createHash('sha256')
              .update(`${TENANT.org}\n${TENANT.app}\n${TENANT.env}\n${requestBody}`)
              .digest('hex')}`,
          }
        : {}),
    },
    body: requestBody,
  });
}

function rollback(deploymentId: string): Promise<Response> {
  return fetch(`${service.url}${targetPath(TENANT)}/rollback`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer owner-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ deploymentId }),
  });
}

async function lockEvents() {
  return (await audit.list({ org: TENANT.org })).filter(
    (event) => event.eventType === 'deployment.lock.updated',
  );
}

function targetPath(target: TenantRef): string {
  return `/v1/orgs/${target.org}/apps/${target.app}/envs/${target.env}`;
}

function manifest(): string {
  return JSON.stringify({
    manifestVersion: '1',
    server: { name: 'submitted_server', version: '1.0.0', title: 'Submitted server' },
    tools: [
      {
        name: 'status',
        description: 'Return the server status.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        fulfilment: { steps: [], output: { ok: true } },
      },
    ],
  });
}

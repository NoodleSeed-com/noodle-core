import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

/**
 * End-to-end proof that the deploy and config/secret write paths emit durable audit events through the
 * wired-in {@link InMemoryAuditStore} system of record — and that no secret value ever reaches the store.
 */

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

function helloManifest(message: string): string {
  return HELLO.replace('Hello, ${input.name}!', `${message}, \${input.name}!`);
}

const ADMIN = { authorization: 'Bearer admin-token' };
const JSON_HEADERS = { 'content-type': 'application/json', ...ADMIN };

const verifier: GoogleIdTokenVerifier = {
  verify: (token, audience) => {
    if (audience !== 'google-client' || token !== 'admin-token') throw new Error('bad token');
    return Promise.resolve({ subject: 'admin-sub', email: 'admin@noodleseed.com' });
  },
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((res, rej) => server?.close((e) => (e ? rej(e) : res())));
  server = undefined;
});

async function start(
  options: { auditModule?: boolean } = {},
): Promise<{ base: string; audit: InMemoryAuditStore }> {
  const audit = new InMemoryAuditStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.createOrg({ slug: 'acme' });
  const loadedModules: LoadedServiceModule[] = options.auditModule
    ? [
        {
          module: {
            name: 'audit',
            version: '0.0.0',
            apiVersion: 1,
            init: () => ({ auditStore: audit }),
          },
          contributions: { auditStore: audit },
          position: 0,
        },
      ]
    : [];
  server = createServer(
    createServiceHandler(new ServerRegistry(), {
      audit,
      controlPlaneStore: controlPlane,
      loadedModules,
      controlPlaneGoogleClientId: 'google-client',
      deployGate: new GoogleControlPlaneGate({
        audience: 'google-client',
        admins: ['admin@noodleseed.com'],
        verifier,
      }),
    }),
  );
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server?.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, audit };
}

describe('audit emission from the control plane', () => {
  it('emits deploy.accepted on a successful deploy', async () => {
    const { base, audit } = await start();
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: HELLO, deploymentSource: 'cli' }),
    });
    expect(res.status).toBe(201);
    const events = await audit.list({ org: 'acme' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'deploy.accepted',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      decision: 'allow',
      actorSubject: 'admin-sub',
      actorEmail: 'admin@noodleseed.com',
      details: { deploymentSource: 'cli' },
    });
    expect(events[0]?.deploymentId).toBeTypeOf('string');
  });

  it('audits an alternate owner without replacing the human deploy or preflight actor', async () => {
    const { base, audit } = await start();
    const ownerSubject = 'oauth-alternate-owner';
    const preflight = await fetch(
      `${base}/v1/orgs/acme/apps/alternate/envs/prod/deploy/preflight`,
      {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ manifest: HELLO, ownerSubject }),
      },
    );
    expect(preflight.status).toBe(200);
    const deploy = await fetch(`${base}/v1/orgs/acme/apps/alternate/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: HELLO, ownerSubject }),
    });
    expect(deploy.status).toBe(201);

    const [preflightEvent] = await audit.list({
      org: 'acme',
      eventType: 'deploy.preflight.checked',
    });
    const [deployEvent] = await audit.list({ org: 'acme', eventType: 'deploy.accepted' });
    expect(preflightEvent).toMatchObject({
      actorSubject: 'admin-sub',
      actorEmail: 'admin@noodleseed.com',
      details: { ownerSubject },
    });
    expect(deployEvent).toMatchObject({
      actorSubject: 'admin-sub',
      actorEmail: 'admin@noodleseed.com',
      details: { ownerSubject },
    });
    expect(JSON.stringify([preflightEvent, deployEvent])).not.toContain('admin-token');
  });

  it('emits deploy.rejected with a safe reason on an invalid manifest', async () => {
    const { base, audit } = await start();
    const res = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: 'not: a valid manifest\n' }),
    });
    expect(res.status).toBe(400);
    const [event] = await audit.list({ org: 'acme', eventType: 'deploy.rejected' });
    expect(event).toMatchObject({
      eventType: 'deploy.rejected',
      org: 'acme',
      decision: 'deny',
      status: '400',
    });
    // The manifest body must never appear in the audit record.
    expect(JSON.stringify(event)).not.toContain('not: a valid manifest');
  });

  it('emits deploy.rejected before returning organization-not-found', async () => {
    const { base, audit } = await start();
    const res = await fetch(`${base}/v1/orgs/not-created/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: HELLO }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      code: 'organization_not_found',
      error: 'organization must be created before deploy',
    });
    const [event] = await audit.list({ org: 'not-created', eventType: 'deploy.rejected' });
    expect(event).toMatchObject({
      eventType: 'deploy.rejected',
      org: 'not-created',
      app: 'hello',
      env: 'prod',
      decision: 'deny',
      status: '404',
      reasonCode: 'organization_not_found',
      actorSubject: 'admin-sub',
      actorEmail: 'admin@noodleseed.com',
    });
  });

  it('emits deploy.rollback with safe deployment metadata', async () => {
    const { base, audit } = await start();
    const first = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        manifest: helloManifest('Hello'),
        ownerSubject: 'oauth-historical-owner',
      }),
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { deploymentId: string };
    const second = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: helloManifest('Goodbye'), accessMode: 'org-members' }),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { deploymentId: string };

    const rollback = await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/rollback`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ deploymentId: firstBody.deploymentId, reason: 'bad deploy' }),
    });
    expect(rollback.status).toBe(200);

    const [event] = await audit.list({ org: 'acme', eventType: 'deploy.rollback' });
    expect(event).toMatchObject({
      eventType: 'deploy.rollback',
      org: 'acme',
      app: 'hello',
      env: 'prod',
      deploymentId: firstBody.deploymentId,
      decision: 'allow',
      actorSubject: 'admin-sub',
      actorEmail: 'admin@noodleseed.com',
      details: {
        previousDeploymentId: secondBody.deploymentId,
        alreadyActive: false,
        accessMode: 'owner-only',
        ownerSubject: 'oauth-historical-owner',
        previousAccessMode: 'org-members',
        reason: 'bad deploy',
      },
    });
    expect(JSON.stringify(event)).not.toContain('Bearer');
    expect(JSON.stringify(event)).not.toContain('Goodbye');
  });

  it('emits config.secret.set/deleted with the name but never the value', async () => {
    const { base, audit } = await start();
    const url = `${base}/v1/orgs/acme/secrets/API_KEY`;
    const put = await fetch(url, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ value: 'sk-super-secret-value' }),
    });
    expect(put.status).toBe(200);
    const del = await fetch(url, { method: 'DELETE', headers: ADMIN });
    expect(del.status).toBe(204);

    const events = await audit.list({ org: 'acme' });
    expect(events.map((e) => e.eventType)).toEqual(['config.secret.deleted', 'config.secret.set']);
    expect(events[1]).toMatchObject({
      eventType: 'config.secret.set',
      org: 'acme',
      actorSubject: 'admin-sub',
      details: { kind: 'secret', name: 'API_KEY' },
    });
    expect(JSON.stringify(events)).not.toContain('sk-super-secret-value');
  });

  it('queries audit events only when the service reports the audit capability', async () => {
    const missing = await start();
    const missingRes = await fetch(`${missing.base}/v1/orgs/acme/audit/events`, {
      headers: ADMIN,
    });
    expect(missingRes.status).toBe(409);
    await new Promise<void>((res, rej) => server?.close((e) => (e ? rej(e) : res())));
    server = undefined;

    const { base, audit } = await start({ auditModule: true });
    const secretUrl = `${base}/v1/orgs/acme/secrets/API_KEY`;
    await fetch(secretUrl, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({ value: 'sk-super-secret-value' }),
    });
    await fetch(`${base}/v1/orgs/acme/apps/hello/envs/prod/deploy`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ manifest: HELLO }),
    });

    const res = await fetch(
      `${base}/v1/orgs/acme/audit/events?eventType=config.secret.set&limit=1`,
      { headers: ADMIN },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      eventType: 'config.secret.set',
      org: 'acme',
      actorSubject: 'admin-sub',
    });
    expect(JSON.stringify(body)).not.toContain('sk-super-secret-value');

    const [queryEvent] = await audit.list({ org: 'acme', eventType: 'audit.events.queried' });
    expect(queryEvent).toMatchObject({
      eventType: 'audit.events.queried',
      org: 'acme',
      decision: 'allow',
      status: '200',
      actorSubject: 'admin-sub',
      details: { eventType: 'config.secret.set', limit: 1, resultCount: 1 },
    });
    expect(JSON.stringify(queryEvent)).not.toContain('sk-super-secret-value');
  });
});

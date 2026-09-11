import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  accessUpdateClientResponseSchema,
  accessUpdateResponseSchema,
} from '@noodle-borg/wire-contracts';
import { expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryAuditStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

it('returns a client-readable legacy access no-op without inventing policy authority', async () => {
  const store = new InMemoryArtifactStore();
  const controlPlane = new InMemoryControlPlaneStore();
  const audit = new InMemoryAuditStore();
  await controlPlane.createOrg({ slug: 'acme' });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await store.append({
    schemaVersion: 1,
    deploymentId: 'legacy-support',
    orgSlug: 'acme',
    appSlug: 'support',
    environment: 'prod',
    deploymentVersion: 1,
    active: true,
    serverName: 'support',
    createdAt: '2026-07-28T00:00:00.000Z',
    createdBySubject: 'owner',
    manifest: '{}',
    secrets: { enc: 'none', values: {} },
  });
  const http = createServer(
    createServiceHandler(new ServerRegistry(store), {
      controlPlaneStore: controlPlane,
      audit,
      deployGate: {
        authorize: () => ({ ok: true, identity: { subject: 'owner', superAdmin: false } }),
      },
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = http.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/v1/orgs/acme/apps/support/envs/prod/access`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
        body: JSON.stringify({ accessMode: 'owner-only' }),
      },
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(accessUpdateClientResponseSchema.parse(body)).toMatchObject({
      changed: false,
      accessChanged: false,
      ownerChanged: false,
      deployment: {
        deploymentId: 'legacy-support',
        accessMode: 'owner-only',
        ownerSubject: 'owner',
      },
    });
    expect(accessUpdateResponseSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty('policyChanged');
    expect(body.deployment).not.toHaveProperty('authentication');
    await expect(store.get('legacy-support')).resolves.not.toHaveProperty('accessMode');
    const events = (await audit.list({ org: 'acme' })).filter(
      (event) => event.eventType === 'deployment.access.updated',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.details).toMatchObject({ changed: false });
    expect(events[0]?.details).not.toHaveProperty('policyChanged');
    expect(events[0]?.details).not.toHaveProperty('authentication');
  } finally {
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

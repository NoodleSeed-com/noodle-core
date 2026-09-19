import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  NativeRecordLifecyclePreviewResponseSchema,
  NativeRecordLifecycleResponseSchema,
} from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { ServerRegistry } from '../src/registry.js';
import { createServiceHandler } from '../src/service.js';

describe('native lifecycle API through the service dispatcher', () => {
  let http: Server,
    base: string,
    store: InMemoryBusinessInformationStore,
    workspaces: BusinessWorkspaceStore;
  const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'native' };
  const path = '/v1/orgs/acme/solution-installations/native/record-lifecycle';
  beforeEach(async () => {
    store = new InMemoryBusinessInformationStore();
    workspaces = new BusinessWorkspaceStore(new InMemoryBusinessWorkspaceBackend(), {
      isIdentityActive: async () => true,
    });
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'legacy-owner',
    });
    await workspaces.initializeNewWorkspace({ org: 'acme', ownerSubject: 'owner' });
    for (const role of ['administrator', 'builder', 'operator', 'viewer'] as const) {
      const invitation = await workspaces.invite({
        org: 'acme',
        actor: 'owner',
        email: `${role}@example.test`,
        role,
        expectedRevision: (await workspaces.inspect('acme', 'owner')).revision,
      });
      await workspaces.accept({
        org: 'acme',
        subject: role,
        token: invitation.token,
        verifiedEmail: `${role}@example.test`,
      });
    }
    http = createServer(
      createServiceHandler(new ServerRegistry(), {
        businessInformationStore: store,
        deployGate: {
          authorize: async (req) => {
            const subject = req.headers.authorization?.replace(/^Bearer /, '');
            return subject
              ? {
                  ok: true,
                  identity: {
                    subject,
                    email: `${subject}@example.test`,
                    superAdmin: subject === 'super-admin',
                  },
                }
              : { ok: false, status: 401, message: 'Sign in required' };
          },
        },
      }),
    );
    // The host configures the shared authority; no shadow authorization implementation in this route.
    store.staff.configure(workspaces);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const request = (actor = 'owner', method = 'GET', body?: unknown, target = path) =>
    fetch(`${base}${target}`, {
      method,
      headers: {
        ...(actor ? { authorization: `Bearer ${actor}` } : {}),
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function preview() {
    return NativeRecordLifecyclePreviewResponseSchema.parse(await (await request()).json()).data;
  }
  it('requires current business Owner or Admin, never developer, stale legacy, or super-admin authority', async () => {
    expect((await request('')).status).toBe(401);
    for (const actor of [
      'builder',
      'operator',
      'viewer',
      'legacy-owner',
      'super-admin',
      'stranger',
    ]) {
      expect((await request(actor)).status).toBe(403);
      expect(
        (await request(actor, 'POST', { preview: await preview(), confirm: true })).status,
      ).toBe(403);
    }
    expect((await request('administrator')).status).toBe(200);
    const review = await preview();
    expect(
      (await request('administrator', 'POST', { preview: review, confirm: true })).status,
    ).toBe(200);
    const changed = await workspaces.inspect('acme', 'owner');
    await workspaces.changeRole({
      org: 'acme',
      actor: 'owner',
      subject: 'administrator',
      role: 'viewer',
      expectedRevision: changed.revision,
    });
    expect(
      (await request('administrator', 'POST', { preview: review, confirm: true })).status,
    ).toBe(403);
  });
  it('validates complete reviews, rejects silent consent and conflicts, and returns strict safe receipts', async () => {
    const review = await preview();
    for (const body of [
      { preview: review },
      { preview: review, confirm: false },
      { preview: review, confirm: true, actor: 'owner' },
    ])
      expect((await request('owner', 'POST', body)).status).toBe(400);
    expect((await request('owner', 'DELETE')).status).toBe(405);
    expect(
      (
        await request('owner', 'POST', {
          preview: { ...review, digest: 'a'.repeat(64) },
          confirm: true,
        })
      ).status,
    ).toBe(409);
    const response = await request('owner', 'POST', { preview: review, confirm: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(NativeRecordLifecycleResponseSchema.parse(await response.json()).data).toMatchObject({
      policy: 'explicit_erasure',
      recordsPreserved: 0,
      replayed: false,
    });
    const replay = await request('owner', 'POST', { preview: review, confirm: true });
    expect(NativeRecordLifecycleResponseSchema.parse(await replay.json()).data.replayed).toBe(true);
    expect(
      (await request('owner', 'GET', undefined, path.replace('/acme/', '/different/'))).status,
    ).toBe(404);
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/portable.js';
import {
  createServiceHandler,
  InMemoryArtifactStore,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

let server: Server;
let base: string;
let store: InMemoryControlPlaneStore;
const optionsPath = '/v1/me/solution-installation-options';

beforeEach(async () => {
  store = new InMemoryControlPlaneStore();
  for (const slug of ['alpha', 'bravo', 'charlie']) {
    await store.createOrg({ slug, displayName: `${slug} business` });
    await store.addOrgMember({
      org: slug,
      subject: 'owner',
      email: 'owner@example.test',
      role: 'owner',
    });
  }
  await store.addOrgMember({
    org: 'alpha',
    subject: 'developer',
    email: 'developer@example.test',
    role: 'developer',
  });
  server = createServer(
    createServiceHandler(new ServerRegistry(new InMemoryArtifactStore()), {
      controlPlaneStore: store,
      businessInformationStore: new InMemoryBusinessInformationStore(),
      deployGate: {
        async authorize(req) {
          const subject = req.headers.authorization?.replace(/^Bearer /, '');
          return subject
            ? {
                ok: true,
                identity: {
                  subject,
                  email: `${subject}@example.test`,
                  superAdmin: subject === 'admin',
                },
              }
            : { ok: false, status: 401, message: 'Authentication required' };
        },
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);
const request = (subject?: string, query = '') =>
  fetch(`${base}${optionsPath}${query}`, {
    headers: subject ? { authorization: `Bearer ${subject}` } : {},
  });

describe('solution installation options', () => {
  it('offers only live owner-authorized organizations without directory or billing data', async () => {
    const response = await request('owner');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      data: {
        organizations: [
          { slug: 'alpha', displayName: 'alpha business' },
          { slug: 'bravo', displayName: 'bravo business' },
          { slug: 'charlie', displayName: 'charlie business' },
        ],
      },
    });
    for (const subject of ['developer', 'outsider']) {
      expect(await (await request(subject)).json()).toEqual({
        ok: true,
        data: { organizations: [] },
      });
    }
    expect((await (await request('admin')).json()).data.organizations).toHaveLength(3);
  });

  it('uses bounded pages and rechecks role changes between requests', async () => {
    const first = await (await request('owner', '?limit=1')).json();
    expect(first.data.organizations).toEqual([{ slug: 'alpha', displayName: 'alpha business' }]);
    expect(typeof first.data.nextCursor).toBe('string');
    await store.updateOrgMemberRole({ org: 'bravo', subject: 'owner', role: 'developer' });
    const next = await (
      await request('owner', `?limit=1&cursor=${encodeURIComponent(first.data.nextCursor)}`)
    ).json();
    expect(next.data.organizations).toEqual([{ slug: 'charlie', displayName: 'charlie business' }]);
    expect(next.data.nextCursor).toBeUndefined();
    expect(
      (
        await (
          await request('outsider', `?cursor=${encodeURIComponent(first.data.nextCursor)}`)
        ).json()
      ).data.organizations,
    ).toEqual([]);
  });

  it('denies unauthenticated, ambiguous paging and unsupported methods', async () => {
    expect((await request()).status).toBe(401);
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=1&limit=2',
      '?cursor=bad!',
      '?cursor=a&cursor=b',
    ]) {
      expect((await request('owner', query)).status, query).toBe(400);
    }
    expect(
      (
        await fetch(`${base}${optionsPath}`, {
          method: 'POST',
          headers: { authorization: 'Bearer owner' },
        })
      ).status,
    ).toBe(405);
  });

  it('does not alter the default whoami contract', async () => {
    const response = await fetch(`${base}/v1/whoami`, {
      headers: { authorization: 'Bearer owner' },
    });
    expect(await response.json()).toEqual({
      ok: true,
      identity: { subject: 'owner', email: 'owner@example.test', superAdmin: false },
      orgs: await store.listOrgsForSubject('owner'),
    });
  });
});

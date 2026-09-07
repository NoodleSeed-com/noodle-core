import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

/**
 * Control-plane surface for org domains (ADR 0181): registering a domain is the grant, removing it is the
 * revocation, and there is no DNS verification step in between.
 */

let http: Server;
let base: string;
let controlPlane: InMemoryControlPlaneStore;

function gate() {
  return {
    authorize: (req: { headers: Record<string, unknown> }) => {
      const token = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (token === 'owner-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'owner-sub', email: 'owner@acme.test', superAdmin: false },
        });
      }
      if (token === 'dev-token') {
        return Promise.resolve({
          ok: true as const,
          identity: { subject: 'dev-sub', email: 'dev@acme.test', superAdmin: false },
        });
      }
      return Promise.resolve({ ok: false as const, status: 401, message: 'missing bearer token' });
    },
  };
}

function domains(token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/domains`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  });
}

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore({ now: () => new Date('2026-07-24T00:00:00.000Z') });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'dev-sub',
    email: 'dev@acme.test',
    role: 'developer',
  });
  const options: ServiceOptions = { controlPlaneStore: controlPlane, deployGate: gate() };
  http = createServer(createServiceHandler(new ServerRegistry(), options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

describe('org domain control-plane routes', () => {
  it('lets an owner register several domains in one call', async () => {
    const res = await domains('owner-token', {
      method: 'POST',
      body: JSON.stringify({ domains: ['abc.com', 'XYZ.com'] }),
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      ok: true,
      data: {
        orgSlug: 'acme',
        domains: [{ domain: 'abc.com' }, { domain: 'xyz.com' }],
      },
    });
  });

  it('lets any org member list domains but rejects member writes', async () => {
    await controlPlane.addOrgDomain({ org: 'acme', domain: 'abc.com' });

    const read = await domains('dev-token');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ data: { domains: [{ domain: 'abc.com' }] } });

    const write = await domains('dev-token', {
      method: 'POST',
      body: JSON.stringify({ domains: ['xyz.com'] }),
    });
    expect(write.status).toBe(403);

    const remove = await fetch(`${base}/v1/orgs/acme/domains/abc.com`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(remove.status).toBe(403);
  });

  it('requires authentication', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/domains`);
    expect(res.status).toBe(401);
  });

  it('removes a domain and reports whether anything was removed', async () => {
    await controlPlane.addOrgDomain({ org: 'acme', domain: 'abc.com' });

    const first = await fetch(`${base}/v1/orgs/acme/domains/ABC.com`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, removed: true });

    const second = await fetch(`${base}/v1/orgs/acme/domains/abc.com`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(second.status).toBe(404);
  });

  it('refuses a public email provider and points at the authenticated access mode', async () => {
    const res = await domains('owner-token', {
      method: 'POST',
      body: JSON.stringify({ domains: ['gmail.com'] }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('authenticated') });
    await expect(controlPlane.listOrgDomains('acme')).resolves.toEqual([]);
  });

  it('rejects a malformed request body', async () => {
    for (const body of [
      {},
      { domains: [] },
      { domains: 'abc.com' },
      { domains: ['not a domain'] },
    ]) {
      const res = await domains('owner-token', { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
    await expect(controlPlane.listOrgDomains('acme')).resolves.toEqual([]);
  });

  it('registers all domains or none when one is invalid', async () => {
    const res = await domains('owner-token', {
      method: 'POST',
      body: JSON.stringify({ domains: ['abc.com', 'gmail.com'] }),
    });

    expect(res.status).toBe(400);
    await expect(controlPlane.listOrgDomains('acme')).resolves.toEqual([]);
  });
});

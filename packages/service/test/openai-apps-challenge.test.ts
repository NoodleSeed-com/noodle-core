import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type ServiceOptions,
} from '../src/index.js';

const EDGE_TOKEN = 'edge-secret';
const CHALLENGE_PATH = '/.well-known/openai-apps-challenge';

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

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore({
    now: () => new Date('2026-07-10T00:00:00.000Z'),
  });
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
  controlPlane.getActiveMcpSubdomain = async (org) =>
    org === 'acme'
      ? { mcpSubdomain: 'arez', orgSlug: 'acme', claimedAt: '2026-08-11T00:00:00.000Z' }
      : undefined;
  controlPlane.resolveActiveMcpSubdomain = async (mcpSubdomain) =>
    mcpSubdomain === 'local'
      ? Promise.reject(new Error('reserved MCP subdomain'))
      : mcpSubdomain === 'arez'
        ? { mcpSubdomain: 'arez', orgSlug: 'acme', claimedAt: '2026-08-11T00:00:00.000Z' }
        : undefined;
  const options: ServiceOptions = {
    controlPlaneStore: controlPlane,
    deployGate: gate(),
    mcpPublicRouting: {
      publicBaseDomain: 'cloud.noodleseed.dev',
      allowedBaseDomains: ['cloud.noodleseed.dev'],
      edgeToken: EDGE_TOKEN,
    },
  };
  http = createServer(createServiceHandler(new ServerRegistry(), options));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function jsonHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

function edgeHeaders(token = EDGE_TOKEN, mcpSubdomain = 'arez'): Record<string, string> {
  return {
    'x-app-host': `https://${mcpSubdomain}.cloud.noodleseed.dev${CHALLENGE_PATH}`,
    'x-noodle-edge-token': token,
  };
}

describe('OpenAI Apps challenge control-plane routes', () => {
  it('lets org owners set and clear the challenge while members can read it', async () => {
    const set = await fetch(`${base}/v1/orgs/acme/openai-apps-challenge`, {
      method: 'PUT',
      headers: jsonHeaders('owner-token'),
      body: JSON.stringify({ challenge: '  openai-domain-code  ' }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({
      ok: true,
      data: {
        orgSlug: 'acme',
        challenge: 'openai-domain-code',
        challengeUrl: 'https://arez.cloud.noodleseed.dev/.well-known/openai-apps-challenge',
      },
    });

    const get = await fetch(`${base}/v1/orgs/acme/openai-apps-challenge`, {
      headers: { authorization: 'Bearer dev-token' },
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({
      ok: true,
      data: { orgSlug: 'acme', challenge: 'openai-domain-code' },
    });

    const clear = await fetch(`${base}/v1/orgs/acme/openai-apps-challenge`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer owner-token' },
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toMatchObject({ ok: true, cleared: true });
  });

  it('rejects non-owner writes and invalid challenge values', async () => {
    const forbidden = await fetch(`${base}/v1/orgs/acme/openai-apps-challenge`, {
      method: 'PUT',
      headers: jsonHeaders('dev-token'),
      body: JSON.stringify({ challenge: 'code' }),
    });
    expect(forbidden.status).toBe(403);

    const invalid = await fetch(`${base}/v1/orgs/acme/openai-apps-challenge`, {
      method: 'PUT',
      headers: jsonHeaders('owner-token'),
      body: JSON.stringify({ challenge: 'one\ntwo' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('single line') });
  });
});

describe('OpenAI Apps public challenge route', () => {
  it('returns the exact stored challenge as plain text for a trusted MCP-subdomain request', async () => {
    await controlPlane.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'openai-domain-code' });
    const res = await fetch(`${base}${CHALLENGE_PATH}`, { headers: edgeHeaders() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('openai-domain-code');
  });

  it('returns 403 for an invalid edge token and 404 when no challenge is configured', async () => {
    await controlPlane.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'openai-domain-code' });
    const forbidden = await fetch(`${base}${CHALLENGE_PATH}`, { headers: edgeHeaders('wrong') });
    expect(forbidden.status).toBe(403);

    await controlPlane.clearOrgOpenAIAppsChallenge('acme');
    const missing = await fetch(`${base}${CHALLENGE_PATH}`, { headers: edgeHeaders() });
    expect(missing.status).toBe(404);
  });

  it('does not expose challenges without a trusted X-App-Host header', async () => {
    await controlPlane.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'openai-domain-code' });
    const res = await fetch(`${base}${CHALLENGE_PATH}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for the old org-slug host after the public subdomain differs', async () => {
    await controlPlane.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'openai-domain-code' });
    const res = await fetch(`${base}${CHALLENGE_PATH}`, {
      headers: {
        'x-app-host': `https://acme.cloud.noodleseed.dev${CHALLENGE_PATH}`,
        'x-noodle-edge-token': EDGE_TOKEN,
      },
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for the reserved local label before claim resolution', async () => {
    await controlPlane.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'openai-domain-code' });
    const res = await fetch(`${base}${CHALLENGE_PATH}`, {
      headers: edgeHeaders(EDGE_TOKEN, 'local'),
    });
    expect(res.status).toBe(404);
  });
});

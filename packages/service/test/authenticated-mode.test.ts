import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet.
    inputSchema:
      type: object
    fulfilment:
      steps: []
      output:
        ok: true
`;

const OWNER_SUBJECT = 'google-owner-sub';

const googleVerifier: GoogleIdTokenVerifier = {
  verify: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
};

let http: Server;
let base: string;

beforeEach(async () => {
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: OWNER_SUBJECT,
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  const gate = new GoogleControlPlaneGate({
    audience: 'test-client-id',
    admins: [],
    verifier: googleVerifier,
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      deployGate: gate,
      controlPlaneStore: controlPlane,
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { caller: { subject: OWNER_SUBJECT } } : null),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function deploy(app: string, accessMode?: string): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
    body: JSON.stringify({
      manifest: HELLO,
      ...(accessMode !== undefined ? { accessMode } : {}),
    }),
  });
}

describe('authenticated access mode', () => {
  it('deploys authenticated apps and requires a signed-in caller at the data plane', async () => {
    const res = await deploy('builder-like', 'authenticated');
    expect(res.status).toBe(201);
    const deployed = (await res.json()) as { url: string; accessMode: string };
    expect(deployed.accessMode).toBe('authenticated');

    const unauth = await fetch(deployed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    expect(unauth.status).toBe(401);

    const authed = await fetch(deployed.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer OWNER',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    expect(authed.status).toBe(200);
  });

  it('accepts access updates to authenticated mode', async () => {
    const deployed = await deploy('patched', 'owner-only');
    expect(deployed.status).toBe(201);

    const access = await fetch(`${base}/v1/orgs/acme/apps/patched/envs/prod/access`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
      body: JSON.stringify({ accessMode: 'authenticated' }),
    });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      deployment: { accessMode: 'authenticated' },
    });
  });

  it('keeps existing tenant-deployable identity modes accepted', async () => {
    const ownerOnly = await deploy('owner-only', 'owner-only');
    expect(ownerOnly.status).toBe(201);
    expect((await ownerOnly.json()).accessMode).toBe('owner-only');

    const orgMembers = await deploy('org-members', 'org-members');
    expect(orgMembers.status).toBe(201);
    expect((await orgMembers.json()).accessMode).toBe('org-members');
  });
});

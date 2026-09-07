import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryControlPlaneStore,
  JsonFileArtifactStore,
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
      properties:
        name:
          type: string
      required: [name]
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };
const OWNER_SUBJECT = 'google-owner-sub';
const MEMBER_SUBJECT = 'google-member-sub';
const ISSUER = 'https://as.noodle.test';

// A Google verifier that accepts any token as the owner — the control-plane identity is fixed for the test.
const googleVerifier: GoogleIdTokenVerifier = {
  verify: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
};

// An owner-token verifier mapping opaque test tokens to subjects (stands in for the OA-2 AS / jose).
const verifyOwnerToken = (token: string): Promise<{ caller: { subject: string } } | null> =>
  Promise.resolve(
    token === 'OWNER'
      ? { caller: { subject: OWNER_SUBJECT } }
      : token === 'MEMBER'
        ? { caller: { subject: MEMBER_SUBJECT } }
        : token === 'OTHER'
          ? { caller: { subject: 'intruder-sub' } }
          : null,
  );

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
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: MEMBER_SUBJECT,
    email: 'member@noodleseed.com',
    role: 'developer',
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
      verifyOwnerToken,
      authServerIssuer: ISSUER,
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function deployPrivate(): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'owner-only' }),
  });
}

function deployDefault(): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/default/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
    body: JSON.stringify({ manifest: HELLO }),
  });
}

function deployOrgMembers(): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/team/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members' }),
  });
}

function mcp(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-protocol-version': '2025-11-25', ...headers },
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 't', version: '1' },
  },
};

describe('owner-only deployments (OA-1)', () => {
  it('defaults deploys to owner-only without minting a caller key', async () => {
    const res = await deployDefault();
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.accessMode).toBe('owner-only');
    expect(json.callerKey).toBeUndefined();
    expect(json.url).toBe(`${base}/o/acme/default/v1/mcp`);
  });

  it('deploys owner-only without minting a caller key', async () => {
    const res = await deployPrivate();
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.accessMode).toBe('owner-only');
    expect(json.callerKey).toBeUndefined();
    expect(json.url).toBe(`${base}/o/acme/priv/v1/mcp`);
  });

  it('rejects a call with no token (401 + resource_metadata challenge)', async () => {
    const { url } = await (await deployPrivate()).json();
    const res = await mcp(url, INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(
      /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/o\/acme\/priv\/v1\/mcp"/,
    );
  });

  it('accepts the owner and runs a real tool call', async () => {
    const { url } = await (await deployPrivate()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer OWNER' })).status).toBe(200);
    const call = await mcp(
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'Ada' } },
      },
      { authorization: 'Bearer OWNER' },
    );
    expect(call.status).toBe(200);
    expect((await call.json()).result.structuredContent).toEqual({ message: 'Hello, Ada!' });
  });

  it('forbids a valid non-owner identity (403)', async () => {
    const { url } = await (await deployPrivate()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer OTHER' })).status).toBe(403);
  });

  it('keeps owner-only stricter than org membership', async () => {
    const { url } = await (await deployPrivate()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer MEMBER' })).status).toBe(403);
  });

  it('rejects an invalid token (401)', async () => {
    const { url } = await (await deployPrivate()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer nonsense' })).status).toBe(401);
  });

  it('serves protected-resource metadata pointing at the authorization server', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/o/acme/priv/v1/mcp`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resource).toBe(`${base}/o/acme/priv/v1/mcp`);
    expect(json.authorization_servers).toEqual([ISSUER]);
  });
});

describe('org-member deployments (OA-3)', () => {
  it('deploys without minting a caller key', async () => {
    const res = await deployOrgMembers();
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.accessMode).toBe('org-members');
    expect(json.callerKey).toBeUndefined();
    expect(json.url).toBe(`${base}/o/acme/team/v1/mcp`);
  });

  it('accepts an org member and runs a real tool call', async () => {
    const { url } = await (await deployOrgMembers()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer MEMBER' })).status).toBe(200);
    const call = await mcp(
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'Lin' } },
      },
      { authorization: 'Bearer MEMBER' },
    );
    expect(call.status).toBe(200);
    expect((await call.json()).result.structuredContent).toEqual({ message: 'Hello, Lin!' });
  });

  it('forbids a valid non-member identity (403)', async () => {
    const { url } = await (await deployOrgMembers()).json();
    expect((await mcp(url, INIT, { authorization: 'Bearer OTHER' })).status).toBe(403);
  });

  it('rejects a call with no token (401 + resource_metadata challenge)', async () => {
    const { url } = await (await deployOrgMembers()).json();
    const res = await mcp(url, INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(
      /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/o\/acme\/team\/v1\/mcp"/,
    );
  });
});

describe('owner-only deployments — persistence + cross-instance recovery (ADR 0036)', () => {
  const tenant = { org: 'acme', app: 'priv', env: 'prod' };
  const actor = { subject: OWNER_SUBJECT, email: 'owner@noodleseed.com', superAdmin: false };

  it('persists access mode + owner subject and recovers them on a cold instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noodle-oa1-'));
    const store = new JsonFileArtifactStore(dir);
    const result = await new ServerRegistry(store).deploy(tenant, HELLO, {
      actor,
      accessMode: 'owner-only',
      ownerSubject: 'oauth-explicit-owner',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accessMode).toBe('owner-only');
    expect(result.callerKey).toBeUndefined();

    // A second registry (a cold Cloud Run instance) lazily recompiles the deployment from the store.
    const recovered = await new ServerRegistry(store).getActiveByTenant(tenant);
    expect(recovered?.accessMode).toBe('owner-only');
    expect(recovered?.ownerSubject).toBe('oauth-explicit-owner');
    expect(recovered?.callerKeyHash).toBeUndefined();
    await expect(store.get(result.deploymentId)).resolves.toMatchObject({
      createdBySubject: OWNER_SUBJECT,
      ownerSubject: 'oauth-explicit-owner',
    });
  });

  it('persists org-member access and recovers its tenant org on a cold instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noodle-oa3-'));
    const store = new JsonFileArtifactStore(dir);
    const result = await new ServerRegistry(store).deploy(
      { org: 'acme', app: 'team', env: 'prod' },
      HELLO,
      { actor, accessMode: 'org-members' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accessMode).toBe('org-members');
    expect(result.callerKey).toBeUndefined();

    const recovered = await new ServerRegistry(store).getActiveByTenant({
      org: 'acme',
      app: 'team',
      env: 'prod',
    });
    expect(recovered?.accessMode).toBe('org-members');
    expect(recovered?.org).toBe('acme');
    expect(recovered?.callerKeyHash).toBeUndefined();
  });

  it('rejects an owner-only deploy that has no authenticated actor', async () => {
    const result = await new ServerRegistry().deploy(tenant, HELLO, { accessMode: 'owner-only' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('identity_access_requires_identity');
  });

  it('rejects an org-member deploy that has no authenticated actor', async () => {
    const result = await new ServerRegistry().deploy(
      { org: 'acme', app: 'team', env: 'prod' },
      HELLO,
      { accessMode: 'org-members' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('identity_access_requires_identity');
  });
});

describe('owner-only deployments — requires an authenticated deployer', () => {
  it('rejects identity deploys when the control plane is open and no identity is present', async () => {
    // A handler with the default open gate (localhost dev): no identity is established.
    const open = createServer(createServiceHandler(new ServerRegistry(), { verifyOwnerToken }));
    await new Promise<void>((resolve) => open.listen(0, '127.0.0.1', resolve));
    const openBase = `http://127.0.0.1:${(open.address() as AddressInfo).port}`;
    try {
      const res = await fetch(`${openBase}/v1/orgs/acme/apps/priv/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO }),
      });
      expect(res.status).toBe(401);
      const orgRes = await fetch(`${openBase}/v1/orgs/acme/apps/team/envs/prod/deploy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members' }),
      });
      expect(orgRes.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => open.close((e) => (e ? reject(e) : resolve())));
    }
  });
});

describe('caller-key removal', () => {
  it('rejects caller-key deploy requests', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/legacy/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer google-id-token' },
      body: JSON.stringify({ manifest: HELLO, accessMode: 'caller-key' }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('caller-key access has been removed');
  });

  it('does not expose key-management routes', async () => {
    const list = await fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/keys`, {
      headers: { authorization: 'Bearer google-id-token' },
    });
    expect(list.status).toBe(404);
    const rotate = await fetch(`${base}/v1/orgs/acme/apps/priv/envs/prod/keys/rotate`, {
      method: 'POST',
      headers: { authorization: 'Bearer google-id-token' },
    });
    expect(rotate.status).toBe(404);
  });
});

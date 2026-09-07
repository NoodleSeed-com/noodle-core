import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceHandler, InMemoryControlPlaneStore, ServerRegistry } from '../src/index.js';
import { servedTargetFor } from '../src/registry-targets.js';

/**
 * Per-deployment membership-source narrowing (ADR 0183): registry validation, the deploy-route 400s,
 * the served-target projection, and run-deploy inheritance.
 */

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
        name: { type: string }
      required: [name]
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello!"
      output:
        message: \${steps.build.message}
`;

const ACTOR = { subject: 'owner-sub', email: 'owner@acme.com', superAdmin: false };
const TENANT = { org: 'acme', app: 'vault', env: 'prod' };

let http: Server;
let base: string;
let controlPlane: InMemoryControlPlaneStore;

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore({ now: () => new Date('2026-07-25T00:00:00.000Z') });
  await controlPlane.addOrgMember({ org: 'acme', ...ACTOR, role: 'owner' });
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      deployGate: { authorize: () => Promise.resolve({ ok: true, identity: ACTOR }) },
      verifyOwnerToken: () =>
        Promise.resolve({ caller: { subject: 'owner-sub', email: 'owner@acme.com' } }),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

function deployBody(extra: Record<string, unknown>) {
  return JSON.stringify({ manifest: HELLO, accessMode: 'org-members', ...extra });
}

function deploy(extra: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/orgs/acme/apps/vault/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: deployBody(extra),
  });
}

describe('registry deploy validation', () => {
  it('stores the narrowing on the deploy record for an org-members deployment', async () => {
    const registry = new ServerRegistry();
    const result = await registry.deploy(TENANT, HELLO, {
      actor: ACTOR,
      accessMode: 'org-members',
      orgMembershipSources: ['explicit'],
    });

    expect(result.ok).toBe(true);
    if (!result.ok || 'superseded' in result) return;
    const record = await registry.get(result.deploymentId);
    expect(record?.orgMembershipSources).toEqual(['explicit']);
  });

  it('rejects an empty list rather than deploying an endpoint nobody can call', async () => {
    const registry = new ServerRegistry();
    const result = await registry.deploy(TENANT, HELLO, {
      actor: ACTOR,
      accessMode: 'org-members',
      orgMembershipSources: [],
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'membership_sources_empty' })],
    });
  });

  it('rejects membership sources on a deployment that is not org-members', async () => {
    const registry = new ServerRegistry();
    const result = await registry.deploy(TENANT, HELLO, {
      actor: ACTOR,
      accessMode: 'authenticated',
      orgMembershipSources: ['explicit'],
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [expect.objectContaining({ code: 'membership_sources_requires_org_members' })],
    });
  });
});

describe('deploy route', () => {
  it('accepts a narrowed deployment', async () => {
    const res = await deploy({ orgMembershipSources: ['explicit'] });
    expect(res.status).toBe(201);
  });

  it('returns 400 when the wire body names an unknown membership source', async () => {
    const res = await deploy({ orgMembershipSources: ['group'] });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the membership source list is empty', async () => {
    const res = await deploy({ orgMembershipSources: [] });
    expect(res.status).toBe(400);
  });

  it('returns a structured code when narrowing a non-org-members deployment', async () => {
    const res = await fetch(`${base}/v1/orgs/acme/apps/vault/envs/prod/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        manifest: HELLO,
        accessMode: 'authenticated',
        orgMembershipSources: ['explicit'],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      errors: [expect.objectContaining({ code: 'membership_sources_requires_org_members' })],
    });
  });
});

describe('served target projection', () => {
  const served = { artifact: { server: { name: 'hello' } } } as never;
  const base_ = {
    schemaVersion: 1,
    deploymentId: 'dep-1',
    orgSlug: 'acme',
    appSlug: 'vault',
    environment: 'prod',
    deploymentVersion: 1,
    active: true,
    serverName: 'hello',
    createdAt: '2026-07-25T00:00:00.000Z',
    manifest: HELLO,
    secrets: { enc: 'none' as const, values: {} },
    orgMembershipSources: ['explicit' as const],
  };

  it('carries the narrowing for an org-members deployment', () => {
    const target = servedTargetFor({ ...base_, accessMode: 'org-members' }, served);
    expect(target.orgMembershipSources).toEqual(['explicit']);
  });

  it('drops it for any other access mode, where it would mean nothing', () => {
    const target = servedTargetFor({ ...base_, accessMode: 'authenticated' }, served);
    expect(target.orgMembershipSources).toBeUndefined();
  });
});

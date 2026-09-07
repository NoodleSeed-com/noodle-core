import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MODULE_API_VERSION, type PlatformPrincipalResolver } from '@noodle-borg/module';
import type { LoadedServiceModule } from '@noodle-borg/service-modules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createServiceHandler,
  InMemoryControlPlaneStore,
  ORG_DOMAIN_TXT_LABEL,
  ServerRegistry,
  verifyOrgDomainDns,
} from '../src/index.js';

const ACCEPT = 'application/json, text/event-stream';
const JSON_HEADERS = { 'content-type': 'application/json', accept: ACCEPT };

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
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

let http: Server;
let base: string;
let controlPlane: InMemoryControlPlaneStore;

beforeEach(async () => {
  controlPlane = new InMemoryControlPlaneStore({ now: () => new Date('2026-06-11T12:00:00.000Z') });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: 'owner-sub',
    email: 'owner@acme.com',
    role: 'owner',
  });
  await controlPlane.addOrgDomain({
    org: 'acme',
    domain: 'acme.com',
    challenge: 'txt-proof',
  });
  await controlPlane.markOrgDomainVerification({
    org: 'acme',
    domain: 'acme.com',
    verified: true,
  });
  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      controlPlaneStore: controlPlane,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@acme.com', superAdmin: false },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(
          token === 'owner'
            ? { caller: { subject: 'owner-sub', email: 'owner@acme.com' } }
            : token === 'employee'
              ? { caller: { subject: 'employee-sub', email: 'employee@acme.com' } }
              : token === 'outsider'
                ? { caller: { subject: 'outsider-sub', email: 'outsider@example.com' } }
                : token === 'abc'
                  ? { caller: { subject: 'abc-sub', email: 'person@abc.test' } }
                  : token === 'xyz'
                    ? { caller: { subject: 'xyz-sub', email: 'person@xyz.test' } }
                    : token === 'other'
                      ? { caller: { subject: 'other-sub', email: 'person@other.test' } }
                      : null,
        ),
      authServerIssuer: 'https://as.noodle.test',
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

describe('org-domain data-plane membership (B10, ADR 0181)', () => {
  it('grants org-members data-plane access without explicit control-plane membership', async () => {
    expect(await controlPlane.isOrgMember({ org: 'acme', subject: 'employee-sub' })).toBe(false);
    expect(
      await controlPlane.isDataPlaneOrgMember({
        org: 'acme',
        subject: 'employee-sub',
        email: 'employee@acme.com',
      }),
    ).toBe(true);
    await expect(controlPlane.listOrgsForSubject('employee-sub')).resolves.toEqual([]);

    const deployed = await deployOrgMembers();
    await expect(call(deployed.url, 'employee')).resolves.toMatchObject({ status: 200 });
    await expect(call(deployed.url, 'outsider')).resolves.toMatchObject({ status: 403 });
  });

  it('keeps membership when the dormant DNS proof is absent (ADR 0181)', async () => {
    // Verification state no longer gates data-plane access: a domain claim only opens the claiming org's
    // own deployments, so a DNS proof defends nothing here. Registration is the grant; removal is the
    // revocation. The proof columns stay for a future org auto-join surface.
    await controlPlane.markOrgDomainVerification({
      org: 'acme',
      domain: 'acme.com',
      verified: false,
    });
    expect(
      await controlPlane.isDataPlaneOrgMember({
        org: 'acme',
        subject: 'employee-sub',
        email: 'employee@acme.com',
      }),
    ).toBe(true);

    await controlPlane.removeOrgDomain({ org: 'acme', domain: 'acme.com' });
    expect(
      await controlPlane.isDataPlaneOrgMember({
        org: 'acme',
        subject: 'employee-sub',
        email: 'employee@acme.com',
      }),
    ).toBe(false);
  });

  it('still records DNS TXT proof state, which no longer gates membership', async () => {
    await controlPlane.markOrgDomainVerification({
      org: 'acme',
      domain: 'acme.com',
      verified: false,
    });

    await expect(
      verifyOrgDomainDns(
        controlPlane,
        { org: 'acme', domain: 'acme.com' },
        {
          resolveTxt: (hostname) => {
            expect(hostname).toBe(`${ORG_DOMAIN_TXT_LABEL}.acme.com`);
            return Promise.resolve([['txt-', 'proof']]);
          },
        },
      ),
    ).resolves.toMatchObject({
      ok: true,
      record: { domain: 'acme.com', verifiedAt: '2026-06-11T12:00:00.000Z' },
    });

    await expect(
      verifyOrgDomainDns(
        controlPlane,
        { org: 'acme', domain: 'acme.com' },
        {
          resolveTxt: () => Promise.resolve([['wrong-proof']]),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      code: 'challenge_missing',
      record: { domain: 'acme.com', lastCheckedAt: '2026-06-11T12:00:00.000Z' },
    });
    // The proof round-trips and is recorded, but membership is unaffected by its outcome.
    expect(
      await controlPlane.isDataPlaneOrgMember({
        org: 'acme',
        subject: 'employee-sub',
        email: 'employee@acme.com',
      }),
    ).toBe(true);
  });
});

describe('multi-domain end-to-end (ADR 0181)', () => {
  it('admits every registered domain, rejects others, and revokes on removal', async () => {
    await controlPlane.removeOrgDomain({ org: 'acme', domain: 'acme.com' });
    await controlPlane.addOrgDomain({ org: 'acme', domain: 'abc.test' });
    await controlPlane.addOrgDomain({ org: 'acme', domain: 'xyz.test' });
    const deployed = await deployOrgMembers();

    await expect(call(deployed.url, 'abc')).resolves.toMatchObject({ status: 200 });
    await expect(call(deployed.url, 'xyz')).resolves.toMatchObject({ status: 200 });
    await expect(call(deployed.url, 'other')).resolves.toMatchObject({ status: 403 });

    await controlPlane.removeOrgDomain({ org: 'acme', domain: 'abc.test' });
    await expect(call(deployed.url, 'abc')).resolves.toMatchObject({ status: 403 });
    await expect(call(deployed.url, 'xyz')).resolves.toMatchObject({ status: 200 });
  });
});

describe('per-deployment membership narrowing (ADR 0183)', () => {
  it('narrows one deployment to explicit members while a sibling in the same org keeps the domain default', async () => {
    // `employee` is admitted only by the acme.com org domain; `owner` is an explicit member.
    const vault = await deployOrgMembers(base, 'vault', { orgMembershipSources: ['explicit'] });
    const team = await deployOrgMembers(base, 'team');

    await expect(call(vault.url, 'owner')).resolves.toMatchObject({ status: 200 });
    await expect(call(vault.url, 'employee')).resolves.toMatchObject({ status: 403 });

    // The sibling in the same org is untouched by the narrowing.
    await expect(call(team.url, 'owner')).resolves.toMatchObject({ status: 200 });
    await expect(call(team.url, 'employee')).resolves.toMatchObject({ status: 200 });
  });
});

describe('verified-address freshness', () => {
  let freshHttp: Server;
  let freshBase: string;

  beforeEach(async () => {
    // The employee's token still claims @acme.com, but their current verified address moved off the domain.
    freshHttp = createServer(
      createServiceHandler(new ServerRegistry(), {
        controlPlaneStore: controlPlane,
        loadedModules: [
          identityModule(
            resolverWithVerifiedEmails('employee-sub', ['employee@former-employer.test']),
          ),
        ],
        deployGate: {
          authorize: () =>
            Promise.resolve({
              ok: true,
              identity: { subject: 'owner-sub', email: 'owner@acme.com', superAdmin: false },
            }),
        },
        verifyOwnerToken: (token) =>
          Promise.resolve(
            token === 'owner'
              ? { caller: { subject: 'owner-sub', email: 'owner@acme.com' } }
              : token === 'employee'
                ? { caller: { subject: 'employee-sub', email: 'employee@acme.com' } }
                : null,
          ),
        authServerIssuer: 'https://as.noodle.test',
      }),
    );
    await new Promise<void>((resolve) => freshHttp.listen(0, '127.0.0.1', resolve));
    freshBase = `http://127.0.0.1:${(freshHttp.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      freshHttp.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it('rejects an employee whose verified address moved off the org domain', async () => {
    const deployed = await deployOrgMembers(freshBase);
    await expect(call(deployed.url, 'employee')).resolves.toMatchObject({ status: 403 });
  });

  it('still admits an explicit member whose principal has no verified-email row', async () => {
    const deployed = await deployOrgMembers(freshBase);
    await expect(call(deployed.url, 'owner')).resolves.toMatchObject({ status: 200 });
  });
});

function resolverWithVerifiedEmails(
  subject: string,
  emails: readonly string[],
): PlatformPrincipalResolver {
  return {
    resolve: async (identity) => ({ subject: identity.subject }),
    resolveLinked: async () => undefined,
    hasVerifiedEmailEvidence: async () => false,
    assertEmailAvailable: async () => undefined,
    resolveExisting: async () => undefined,
    assertActive: async () => undefined,
    lookupActiveVerifiedEmails: async (principalId) =>
      principalId === subject ? { kind: 'known', emails } : { kind: 'unknown' },
  };
}

function identityModule(principalResolver: PlatformPrincipalResolver): LoadedServiceModule {
  const contributions = { platformHumanIdentity: { principalResolver } };
  return {
    module: {
      name: 'test-platform-identity',
      version: '0.0.0',
      apiVersion: MODULE_API_VERSION,
      init: () => contributions,
    },
    contributions,
    position: 0,
  };
}

async function deployOrgMembers(
  atBase: string = base,
  app = 'team',
  extra: Record<string, unknown> = {},
): Promise<{ url: string }> {
  const res = await fetch(`${atBase}/v1/orgs/acme/apps/${app}/envs/prod/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members', ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { url: string };
}

async function call(url: string, token: string): Promise<{ status: number; body: unknown }> {
  const init = await fetch(url, {
    method: 'POST',
    headers: { ...JSON_HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }),
  });
  if (init.status !== 200) return { status: init.status, body: await init.json() };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'call',
      method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'Ada' } },
    }),
  });
  return { status: res.status, body: await res.json() };
}

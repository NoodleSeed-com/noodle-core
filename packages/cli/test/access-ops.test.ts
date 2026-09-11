import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const CUSTOMER_AUTH_SERVER = join(
  import.meta.dirname,
  'fixtures',
  'embedded-assistant-auth',
  'server.ts',
);
const HELLO_SERVER = join(import.meta.dirname, 'fixtures', 'archive-hello-server.ts');
const TARGET = { org: 'acme', app: 'access-app', env: 'staging' } as const;
const ACCESS_MODES = [
  'owner-only',
  'org-members',
  'authenticated',
  'public',
  'mixed',
  'customers',
] as const;

let service: RunningService;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const controlPlaneStore = new InMemoryControlPlaneStore();
  await controlPlaneStore.createOrg({ slug: TARGET.org });
  await controlPlaneStore.addOrgMember({
    org: TARGET.org,
    subject: 'owner-subject',
    email: 'owner@acme.test',
    role: 'owner',
  });
  await controlPlaneStore.addOrgMember({
    org: TARGET.org,
    subject: 'member-subject',
    email: 'member@acme.test',
    role: 'developer',
  });
  service = await serveService({
    port: 0,
    controlPlaneStore,
    deployGate: {
      authorize: (req) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (token === 'owner-token') {
          return Promise.resolve({
            ok: true,
            identity: {
              subject: 'owner-subject',
              email: 'owner@acme.test',
              superAdmin: false,
            },
          });
        }
        if (token === 'member-token') {
          return Promise.resolve({
            ok: true,
            identity: {
              subject: 'member-subject',
              email: 'member@acme.test',
              superAdmin: false,
            },
          });
        }
        return Promise.resolve({ ok: false, status: 401, message: 'valid bearer token required' });
      },
    },
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-access-cli-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  errSpy.mockRestore();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function loggedIn(token: 'owner-token' | 'member-token'): void {
  writeConfig({ serviceUrl: service.url, authToken: token, defaultOrg: TARGET.org }, home);
}

async function setHostedValue(
  collection: 'secrets' | 'variables',
  name: string,
  value: string,
  app: string,
): Promise<void> {
  expect(
    await run(
      [
        collection,
        'set',
        name,
        '--runtime',
        'cloud',
        '--scope',
        'env',
        '--org',
        TARGET.org,
        '--app',
        app,
        '--env',
        TARGET.env,
        '--value',
        value,
        '--json',
      ],
      {},
      home,
    ),
  ).toBe(0);
  logSpy.mockClear();
}

async function deployApp(
  app: string,
  server = CUSTOMER_AUTH_SERVER,
  accessMode: (typeof ACCESS_MODES)[number] = 'owner-only',
): Promise<void> {
  loggedIn('owner-token');
  if (server === CUSTOMER_AUTH_SERVER) {
    await setHostedValue('secrets', 'ASSISTANT_MODEL_API_KEY', 'test-assistant-key', app);
    await setHostedValue('variables', 'ASSISTANT_MODEL_BASE_URL', 'https://model.test', app);
    await setHostedValue('variables', 'ASSISTANT_MODEL', 'test-model', app);
  }
  const exitCode = await run(
    [
      'deploy',
      server,
      '--org',
      TARGET.org,
      '--app',
      app,
      '--env',
      TARGET.env,
      '--version',
      '1',
      '--access',
      accessMode,
      '--no-prompt',
    ],
    {},
    home,
  );
  expect(exitCode, `${stdout()}\n${stderr()}`).toBe(0);
  logSpy.mockClear();
}

function accessArgs(app: string, mode: (typeof ACCESS_MODES)[number]): string[] {
  return ['access', 'set', mode, '--org', TARGET.org, '--app', app, '--env', TARGET.env, '--json'];
}

describe('noodle access set', () => {
  it('transfers owner-only access to an explicit OAuth subject and returns the exact owner', async () => {
    await deployApp('owner-transfer');

    expect(
      await run(
        [...accessArgs('owner-transfer', 'owner-only'), '--owner-subject', 'oauth-human-2'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: {
        target: { ...TARGET, app: 'owner-transfer' },
        deployment: { accessMode: 'owner-only', ownerSubject: 'oauth-human-2' },
        ownerChanged: true,
        changed: true,
      },
    });
    expect(stdout()).not.toContain('owner-token');
  });

  it('accepts and strips additive access response fields at every object layer', async () => {
    writeConfig(
      {
        serviceUrl: 'https://service.example.test',
        authToken: 'additive-client-token',
        defaultOrg: TARGET.org,
      },
      home,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          ok: true,
          target: {
            ...TARGET,
            app: 'additive-response',
            futureTargetField: 'private-target-detail',
          },
          deployment: {
            deploymentId: 'dep_additive',
            serverVersion: '1',
            accessMode: 'owner-only',
            ownerSubject: 'oauth-human-2',
            futureDeploymentField: 'private-deployment-detail',
          },
          previousAccessMode: 'owner-only',
          previousOwnerSubject: 'owner-subject',
          accessChanged: false,
          ownerChanged: true,
          changed: true,
          futureEnvelopeField: 'private-envelope-detail',
        }),
      ),
    );

    expect(
      await run(
        [...accessArgs('additive-response', 'owner-only'), '--owner-subject', 'oauth-human-2'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        ok: true,
        target: { ...TARGET, app: 'additive-response' },
        deployment: {
          deploymentId: 'dep_additive',
          serverVersion: '1',
          accessMode: 'owner-only',
          ownerSubject: 'oauth-human-2',
        },
        previousAccessMode: 'owner-only',
        previousOwnerSubject: 'owner-subject',
        accessChanged: false,
        ownerChanged: true,
        changed: true,
        service: 'https://service.example.test',
      },
    });
    expect(stdout()).not.toContain('private-');
    expect(stdout()).not.toContain('additive-client-token');
  });

  it('accepts the legacy access response and derives only its observable mode change', async () => {
    writeConfig(
      {
        serviceUrl: 'https://service.example.test',
        authToken: 'legacy-client-token',
        defaultOrg: TARGET.org,
      },
      home,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json({
          ok: true,
          target: { ...TARGET, app: 'legacy-response' },
          deployment: {
            deploymentId: 'dep_legacy',
            accessMode: 'owner-only',
          },
          previousAccessMode: 'public',
          changed: true,
        }),
      ),
    );

    expect(await run(accessArgs('legacy-response', 'owner-only'), {}, home)).toBe(0);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        ok: true,
        target: { ...TARGET, app: 'legacy-response' },
        deployment: {
          deploymentId: 'dep_legacy',
          accessMode: 'owner-only',
        },
        previousAccessMode: 'public',
        accessChanged: true,
        changed: true,
        service: 'https://service.example.test',
      },
    });
    expect(stdout()).not.toContain('legacy-client-token');
    expect(stdout()).not.toContain('ownerChanged');
  });

  it.each([
    undefined,
    {},
    { mixedCustomerAuth: 0 },
  ])('refuses ambiguous mixed adoption on an older service %j', async (features) => {
    writeConfig(
      {
        serviceUrl: 'https://service.example.test',
        authToken: 'policy-client-token',
        defaultOrg: TARGET.org,
      },
      home,
    );
    const fetchSpy = vi.fn<typeof fetch>(async () =>
      Response.json({
        ok: true,
        status: 'ok',
        version: 'old',
        gitSha: 'abc',
        buildTime: 'now',
        ...(features === undefined ? {} : { features }),
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    expect(await run(accessArgs('legacy-mixed', 'mixed'), {}, home)).not.toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'mixed_customer_auth_unsupported' },
    });
    expect(fetchSpy.mock.calls.every(([url]) => String(url).endsWith('/v1/service/info'))).toBe(
      true,
    );
  });

  it('shows future effective authentication separately from mixed access', async () => {
    writeConfig(
      {
        serviceUrl: 'https://service.example.test',
        authToken: 'policy-client-token',
        defaultOrg: TARGET.org,
      },
      home,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (url) =>
        String(url).endsWith('/v1/service/info')
          ? Response.json({
              ok: true,
              status: 'ok',
              version: 'new',
              gitSha: 'abc',
              buildTime: 'now',
              features: { mixedCustomerAuth: 1 },
            })
          : Response.json({
              ok: true,
              target: { ...TARGET, app: 'policy-response' },
              deployment: {
                deploymentId: 'dep_policy',
                accessMode: 'mixed',
                authentication: 'customer',
              },
              previousAccessMode: 'mixed',
              accessChanged: false,
              ownerChanged: false,
              policyChanged: true,
              changed: true,
            }),
      ),
    );

    expect(
      await run(
        accessArgs('policy-response', 'mixed').filter((arg) => arg !== '--json'),
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('access:  mixed');
    expect(stdout()).toContain('auth:    customer');
    expect(stdout()).toContain('policy:  updated');
    logSpy.mockClear();
    expect(await run(accessArgs('policy-response', 'mixed'), {}, home)).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: true,
      data: {
        accessChanged: false,
        policyChanged: true,
        changed: true,
        deployment: { accessMode: 'mixed', authentication: 'customer' },
      },
    });
    expect(stdout()).not.toContain('policy-client-token');
  });

  it.each(
    ACCESS_MODES.filter((mode) => mode !== 'owner-only'),
  )('rejects --owner-subject locally for %s access', async (mode) => {
    await deployApp(`invalid-owner-${mode}`);
    const realFetch = globalThis.fetch;
    const fetchSpy = vi.fn<typeof fetch>((input, init) => realFetch(input, init));
    vi.stubGlobal('fetch', fetchSpy);

    expect(
      await run(
        [...accessArgs(`invalid-owner-${mode}`, mode), '--owner-subject', 'oauth-human-2'],
        {},
        home,
      ),
    ).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'invalid_owner_subject_mode' },
    });
  });

  it('prints owner-specific recovery when a legacy ownerless deployment enters owner-only mode', async () => {
    writeConfig(
      {
        serviceUrl: 'https://service.example.test',
        authToken: 'owner-token',
        defaultOrg: TARGET.org,
      },
      home,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            ok: false,
            error: 'owner-only access requires an owner identity',
            code: 'owner_identity_required',
          },
          { status: 409 },
        ),
      ),
    );

    expect(await run(accessArgs('ownerless-recovery', 'owner-only'), {}, home)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: {
        code: 'owner_identity_required',
        next: expect.stringContaining('--owner-subject <subject>'),
      },
    });
  });

  it('sends every canonical mode to the exact app environment and returns its updated mode as JSON', async () => {
    await deployApp(TARGET.app);

    for (const mode of ACCESS_MODES) {
      expect(await run(accessArgs(TARGET.app, mode), {}, home)).toBe(0);
      expect(JSON.parse(stdout())).toMatchObject({
        ok: true,
        data: {
          target: TARGET,
          deployment: {
            accessMode: mode,
            authentication:
              mode === 'public'
                ? 'none'
                : mode === 'customers' || mode === 'mixed'
                  ? 'customer'
                  : 'platform',
          },
          policyChanged: mode === 'mixed',
        },
      });
      logSpy.mockClear();
    }
  });

  it('gives a denied organization member owner-specific recovery without leaking their token', async () => {
    await deployApp('member-denied');
    loggedIn('member-token');

    expect(await run(accessArgs('member-denied', 'public'), {}, home)).toBe(3);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'organization_owner_required' },
    });
    logSpy.mockClear();

    const result = await run(accessArgs('member-denied', 'public').slice(0, -1), {}, home);

    expect(result).toBe(3);
    expect(stderr()).toContain('organization owner');
    expect(stderr()).toContain('Ask an organization owner');
    expect(stderr()).not.toContain('token');
    expect(stderr()).not.toContain('member-token');

    loggedIn('owner-token');
    errSpy.mockClear();
    expect(
      await run(
        ['status', '--org', TARGET.org, '--app', 'member-denied', '--env', TARGET.env, '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toMatchObject({
      data: { deployment: { accessMode: 'owner-only' } },
    });
  });

  it('preserves a typed access prerequisite conflict for JSON callers', async () => {
    await deployApp('prerequisite-conflict', HELLO_SERVER);

    expect(await run(accessArgs('prerequisite-conflict', 'customers'), {}, home)).toBe(1);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'server_auth_required' },
    });
  });
});

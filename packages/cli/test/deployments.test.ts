import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG } from '../src/commands/catalog.js';
import { deploymentsListFrame, renderDeploymentsTable } from '../src/commands/deployments-ops.js';
import type { DeploymentResponse, DeploymentSummary } from '../src/commands/resource-shared.js';
import { readServers, run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle deployments list` / `noodle deployments inspect` verified against a real service
 * instance — same pattern as `apps.test.ts`/`envs.test.ts`: an in-process service with a
 * superAdmin deploy gate, seeded by running the CLI's own `deploy` command against a fixture
 * server. Also covers the hard-error promotion of `noodle list` (ADR 0128 D4).
 */

const HELLO = join(import.meta.dirname, 'fixtures', 'archive-hello-server.ts');

const GUIDED = `
manifestVersion: '2'
server:
  name: guided_cli
  title: Guided CLI
  version: 1.0.0
  agentGuide:
    description: Use Guided CLI to list records.
    useWhen: [A user asks for guided records.]
    workflows:
      - id: list_records
        title: List records
        steps: [{ capability: { kind: tool, name: list_records } }]
    boundaries: [Do not invent guided records.]
    examples: [{ prompt: List guided records., workflow: list_records }]
tools:
  - name: list_records
    description: List guided records.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { records: [] } }
`;

let service: RunningService;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const controlPlaneStore = new InMemoryControlPlaneStore();
  await controlPlaneStore.createOrg({ slug: 'acme' });
  service = await serveService({
    port: 0,
    controlPlaneStore,
    deployGate: {
      authorize: (req) => {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (token !== 'admin-token')
          return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
        return Promise.resolve({
          ok: true,
          identity: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
        });
      },
    },
    verifyOwnerToken: () => Promise.resolve(null),
    authServerIssuer: 'https://as.noodle.test',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-deployments-cli-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return logSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

function loggedIn(org = 'acme'): void {
  writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: org }, home);
}

async function deployHello(app: string, targetEnv = 'prod'): Promise<{ deploymentId: string }> {
  expect(
    await run(
      ['deploy', HELLO, '--org', 'acme', '--app', app, '--env', targetEnv, '--version', '1'],
      {},
      home,
    ),
  ).toBe(0);
  const deploymentId = /deploymentId:\s+(\S+)/.exec(stdout())?.[1];
  expect(deploymentId).toBeDefined();
  logSpy.mockClear();
  return { deploymentId: deploymentId as string };
}

async function deployGuided(app: string, targetEnv = 'prod'): Promise<{ deploymentId: string }> {
  const result = await service.registry.deploy({ org: 'acme', app, env: targetEnv }, GUIDED, {
    accessMode: 'owner-only',
    serverVersion: '1',
    actor: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('guided CLI fixture deployment failed');
  return { deploymentId: result.deploymentId };
}

function recursiveProjectListing(): readonly string[] {
  return (readdirSync('.', { recursive: true }) as string[]).map(String).sort();
}

describe('noodle deployments list', () => {
  it('renders a branded table with deployment, env, version, status, access, and created columns', async () => {
    loggedIn();
    await deployHello('dep-list-cli', 'prod');
    await deployHello('dep-list-cli', 'staging');

    expect(await run(['deployments', 'list', '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain('DEPLOYMENT');
    expect(out).toContain('ENV');
    expect(out).toContain('VERSION');
    expect(out).toContain('STATUS');
    expect(out).toContain('ACCESS');
    expect(out).toContain('CREATED');
    expect(out).toContain('prod');
    expect(out).toContain('staging');
    expect(out).toContain('1');
    expect(out).toContain('active');
    expect(out).toContain('owner-only');
    expect(out).not.toContain('admin-sub');
    // The fixture server (`archive-hello-server.ts`) names itself "hello"; deploymentId is minted
    // from the server name, not the `--app` slug (see `registry.ts`'s `mintDeploymentId`).
    expect(out).toMatch(/hello-\S+/);
    expect(out).toContain('deployment(s) from');
  });

  it('emits exactly {ok:true,data:{deployments}} under --json', async () => {
    loggedIn();
    const { deploymentId } = await deployHello('dep-json-cli');

    expect(await run(['deployments', 'list', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(['deployments']);
    expect(
      body.data.deployments.some((d: DeploymentSummary) => d.deploymentId === deploymentId),
    ).toBe(true);
  });

  it('--app filters the list to one app', async () => {
    loggedIn();
    await deployHello('dep-filter-a-cli');
    await deployHello('dep-filter-b-cli');

    expect(
      await run(
        ['deployments', 'list', '--org', 'acme', '--app', 'dep-filter-a-cli', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.data.deployments.length).toBeGreaterThan(0);
    expect(
      body.data.deployments.every((d: DeploymentSummary) => d.appSlug === 'dep-filter-a-cli'),
    ).toBe(true);
  });

  it('--env filters the list to one environment', async () => {
    loggedIn();
    await deployHello('dep-env-filter-cli', 'prod');
    await deployHello('dep-env-filter-cli', 'staging');

    expect(
      await run(
        [
          'deployments',
          'list',
          '--org',
          'acme',
          '--app',
          'dep-env-filter-cli',
          '--env',
          'staging',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.data.deployments.length).toBe(1);
    expect(body.data.deployments[0].environment).toBe('staging');
  });

  it('--archived includes archived deployments that the default list hides', async () => {
    loggedIn();
    await deployHello('dep-archive-cli');
    expect(await run(['archive', 'dep-archive-cli', '--org', 'acme', '--yes'], {}, home)).toBe(0);
    logSpy.mockClear();

    expect(
      await run(
        ['deployments', 'list', '--org', 'acme', '--app', 'dep-archive-cli', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const hidden = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(hidden.data.deployments.length).toBe(0);
    logSpy.mockClear();

    expect(
      await run(
        [
          'deployments',
          'list',
          '--org',
          'acme',
          '--app',
          'dep-archive-cli',
          '--archived',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const shown = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(shown.data.deployments.length).toBe(1);
    expect(shown.data.deployments[0].archivedAt).toEqual(expect.any(String));
  });

  it('--watch combined with --json is a usage error, not a silent pick of one', async () => {
    loggedIn();
    expect(await run(['deployments', 'list', '--org', 'acme', '--watch', '--json'], {}, home)).toBe(
      2,
    );
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe(
      'watch_json_conflict',
    );
  });
});

describe('deploymentsListFrame — the fetch+render --watch polls', () => {
  it('renders the same table content the one-shot list prints', async () => {
    loggedIn();
    await deployHello('watch-frame-dep-cli');
    const result = await deploymentsListFrame(
      'acme',
      { serviceUrl: service.url, token: 'admin-token' },
      { json: false, archived: false },
      home,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame).toMatch(/hello-\S+/);
  });

  it('falls back to the local saved-servers cache when org/token do not resolve', async () => {
    const result = await deploymentsListFrame(
      undefined,
      { serviceUrl: service.url, token: undefined },
      { json: false, archived: false },
      home,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame).toContain('No saved servers.');
  });

  it('resolves a CliFailure (not a throw) when the hosted fetch fails', async () => {
    const result = await deploymentsListFrame(
      'acme',
      { serviceUrl: 'http://127.0.0.1:1', token: 'admin-token' },
      { json: false, archived: false },
      home,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBeDefined();
  });
});

describe('noodle deployments list — local fallback (no org/token)', () => {
  it('shows a friendly empty state with no saved servers', async () => {
    expect(await run(['deployments', 'list'], {}, home)).toBe(0);
    expect(stdout()).toContain('No saved servers.');
  });

  it('emits the local-fallback JSON envelope unchanged when empty', async () => {
    expect(await run(['deployments', 'list', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { target: { runtime: 'local' }, deployments: [] },
    });
  });

  it('lists a locally-saved server recorded by `deploy --save`, matching legacy `noodle list`', async () => {
    const controlPlaneStore = new InMemoryControlPlaneStore();
    await controlPlaneStore.createOrg({ slug: 'local' });
    const local = await serveService({
      port: 0,
      controlPlaneStore,
      deployGate: {
        authorize: () =>
          Promise.resolve({
            ok: true,
            identity: { subject: 'owner-sub', email: 'owner@noodleseed.com', superAdmin: true },
          }),
      },
      verifyOwnerToken: (token) =>
        Promise.resolve(token === 'OWNER' ? { subject: 'owner-sub' } : null),
      authServerIssuer: 'https://as.noodle.test',
    });
    try {
      expect(await run(['login', '--service', local.url], {}, home)).toBe(0);
      expect(await run(['deploy', HELLO, '--version', '1', '--save'], {}, home)).toBe(0);
      const saved = readServers(home);
      expect(saved).toHaveLength(1);
      logSpy.mockClear();

      expect(await run(['deployments', 'list'], {}, home)).toBe(0);
      const out = stdout();
      expect(out).toContain(saved[0]?.deploymentId as string);
      expect(out).toContain('server(s) cached in ~/.noodle/servers.json.');
    } finally {
      await local.close();
    }
  });

  it('falls back to local when an org resolves via config but no token is present', async () => {
    writeConfig({ serviceUrl: service.url, defaultOrg: 'acme' }, home);
    expect(await run(['deployments', 'list', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { target: { runtime: 'local' }, deployments: [] },
    });
  });

  it('falls back to local when a token is present but no org can be resolved', async () => {
    expect(
      await run(
        ['deployments', 'list', '--json'],
        { NOODLE_AUTH_TOKEN: 'admin-token', NOODLE_SERVICE_URL: service.url },
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { target: { runtime: 'local' }, deployments: [] },
    });
  });
});

describe('noodle deployments inspect', () => {
  it('renders a detail block for a known deployment', async () => {
    loggedIn();
    const { deploymentId } = await deployHello('dep-inspect-cli');

    expect(await run(['deployments', 'inspect', deploymentId, '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain(deploymentId);
    expect(out).toContain('acme');
    expect(out).toContain('dep-inspect-cli');
    expect(out).toContain('prod');
    expect(out).toContain('active');
    expect(out).toMatch(/owner:\s+admin-sub/);
  });

  it('emits the DeploymentSummary under --json', async () => {
    loggedIn();
    const { deploymentId } = await deployHello('dep-inspect-json-cli');

    expect(
      await run(['deployments', 'inspect', deploymentId, '--org', 'acme', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(true);
    expect(body.data.deploymentId).toBe(deploymentId);
    expect(body.data.appSlug).toBe('dep-inspect-json-cli');
    expect(body.data.ownerSubject).toBe('admin-sub');
  });

  it('shows the archived stamp for an archived deployment', async () => {
    loggedIn();
    const { deploymentId } = await deployHello('dep-inspect-archived-cli');
    expect(
      await run(['archive', 'dep-inspect-archived-cli', '--org', 'acme', '--yes'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await run(['deployments', 'inspect', deploymentId, '--org', 'acme', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.data.archivedAt).toEqual(expect.any(String));

    logSpy.mockClear();
    expect(await run(['deployments', 'inspect', deploymentId, '--org', 'acme'], {}, home)).toBe(0);
    expect(stdout()).toContain('archived');
  });

  it('exits 1 with a friendly not-found for an unknown deployment id', async () => {
    loggedIn();
    expect(
      await run(
        ['deployments', 'inspect', 'ghost-deployment-cli', '--org', 'acme', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('not_found');
    expect(body.error.next).toBe('noodle deployments list --org acme');
  });

  it('404s a cross-org deployment id identically to an unknown one (security regression guard)', async () => {
    loggedIn('acme');
    const { deploymentId } = await deployHello('dep-cross-org-cli');
    logSpy.mockClear();

    // The fixture's deploy gate identity is superAdmin, so it can address any org slug; only the
    // target org in the URL changes. A deployment created under `acme` must 404 under a different org.
    expect(
      await run(
        ['deployments', 'inspect', deploymentId, '--org', 'other-org-cli', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('not_found');
  });

  it('exits 2 when no deployment id is given', async () => {
    loggedIn();
    expect(await run(['deployments', 'inspect', '--org', 'acme'], {}, home)).toBe(2);
  });
});

describe('noodle deployments package', () => {
  it('is catalogued with one required id and the canonical inspect flags', () => {
    const deployments = CATALOG.find((command) => command.name === 'deployments');
    const inspect = deployments?.subcommands?.find((command) => command.name === 'inspect');
    const packageCommand = deployments?.subcommands?.find((command) => command.name === 'package');
    expect(inspect).toBeDefined();
    expect(packageCommand).toBeDefined();
    expect(inspect?.flags.length).toBeGreaterThan(0);
    expect(packageCommand?.flags.length).toBeGreaterThan(0);
    expect(packageCommand?.arguments).toEqual([
      expect.objectContaining({ name: 'id', required: true }),
    ]);
    expect(packageCommand?.flags).toEqual(inspect?.flags);
  });

  it('exits 2 with the exact package usage when the deployment id is missing', async () => {
    loggedIn();
    expect(await run(['deployments', 'package', '--org', 'acme', '--json'], {}, home)).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: false,
      error: {
        code: 'usage_error',
        message: 'noodle deployments package requires a deployment id',
        cause: 'noodle deployments is missing a required action or positional argument.',
        fix: 'Pass the required action and positional arguments.',
        next: 'noodle deployments package <deployment-id> [--org <org>] [--service <url>] [--auth-token <token>] [--json]',
      },
    });
  });

  it.each([
    ['an extra deployment id', ['deployment-one', 'deployment-two', '--org', 'acme', '--json']],
    ['the unsupported archived flag', ['deployment-one', '--archived', '--org', 'acme', '--json']],
    ['an unknown flag', ['deployment-one', '--future-flag', '--org', 'acme', '--json']],
  ])('rejects %s with exact usage before any service call', async (_label, args) => {
    loggedIn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await run(['deployments', 'package', ...args], {}, home)).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
        ok: false,
        error: {
          code: 'usage_error',
          message: 'invalid noodle deployments package arguments',
          cause: 'The command accepts exactly one deployment id and only its documented flags.',
          fix: 'Remove extra arguments and unsupported flags.',
          next: 'noodle deployments package <deployment-id> [--org <org>] [--service <url>] [--auth-token <token>] [--json]',
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('prints identity, provenance, hashes, and target files without printing file content', async () => {
    loggedIn();
    const { deploymentId } = await deployGuided('guided-package-human');
    const stored = await service.registry.getDeploymentPackage('acme', deploymentId);
    expect(stored).toBeDefined();
    const before = recursiveProjectListing();

    expect(await run(['deployments', 'package', deploymentId, '--org', 'acme'], {}, home)).toBe(0);

    expect(recursiveProjectListing()).toEqual(before);
    const out = stdout();
    expect(out).toContain(deploymentId);
    expect(out).toContain(stored?.snapshot.artifact.app.name as string);
    expect(out).toContain(stored?.snapshot.artifact.provenance.compilerVersion as string);
    expect(out).toContain(stored?.snapshot.rendererVersion as string);
    expect(out).toContain(stored?.snapshot.artifact.provenance.sourceManifestSha256 as string);
    expect(out).toContain(stored?.snapshot.artifact.provenance.mcpSurfaceSha256 as string);
    expect(out).toContain(stored?.snapshot.snapshotSha256 as string);
    for (const file of stored?.snapshot.files ?? []) {
      expect(out).toContain(file.path);
      expect(out).toContain(String(file.byteLength));
      expect(out).toContain(file.sha256);
    }
    expect(out).not.toContain('Do not invent guided records.');
  });

  it('returns the complete typed service data under --json without writing files', async () => {
    loggedIn();
    const { deploymentId } = await deployGuided('guided-package-json');
    const stored = await service.registry.getDeploymentPackage('acme', deploymentId);
    const before = recursiveProjectListing();

    expect(
      await run(['deployments', 'package', deploymentId, '--org', 'acme', '--json'], {}, home),
    ).toBe(0);

    expect(recursiveProjectListing()).toEqual(before);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: stored,
    });
    expect(JSON.stringify(stored)).toContain('Do not invent guided records.');
  });

  it('maps a service 401 to auth_required without echoing the service response', async () => {
    const { deploymentId } = await deployGuided('guided-package-auth');
    expect(
      await run(
        [
          'deployments',
          'package',
          deploymentId,
          '--org',
          'acme',
          '--service',
          service.url,
          '--auth-token',
          'invalid-token',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'auth_required', next: 'noodle login' },
    });
  });

  it('maps unknown and cross-org reads to the same not_found recovery', async () => {
    loggedIn();
    const { deploymentId } = await deployGuided('guided-package-cross-org');
    for (const [id, org] of [
      ['ghost-deployment-cli', 'acme'],
      [deploymentId, 'other-org-cli'],
    ] as const) {
      logSpy.mockClear();
      expect(await run(['deployments', 'package', id, '--org', org, '--json'], {}, home)).toBe(1);
      expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        error: { code: 'not_found', next: `noodle deployments list --org ${org}` },
      });
    }
  });

  it('maps legacy package_unavailable to typed redeploy recovery without file content', async () => {
    loggedIn();
    const { deploymentId } = await deployHello('legacy-package-cli');
    expect(
      await run(['deployments', 'package', deploymentId, '--org', 'acme', '--json'], {}, home),
    ).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body).toMatchObject({
      ok: false,
      error: { code: 'package_unavailable', next: 'noodle deploy' },
    });
    expect(JSON.stringify(body)).not.toContain('content');
  });
});

describe('noodle deployments lock and unlock', () => {
  it('locks a version, shows the lock in read surfaces, and blocks accidental deploys', async () => {
    loggedIn();
    const app = 'dep-lock-cli';
    const { deploymentId } = await deployHello(app);

    const lockExit = await run(
      ['deployments', 'lock', '--org', 'acme', '--app', app, '--env', 'prod', '--version', '1'],
      {},
      home,
    );
    expect(lockExit, stderr()).toBe(0);
    expect(stdout()).toContain('locked:   yes');
    expect(stdout()).toContain(deploymentId);
    expect(stdout()).toContain(`noodle deployments unlock --version 1`);

    logSpy.mockClear();
    expect(await run(['deployments', 'list', '--org', 'acme', '--app', app], {}, home)).toBe(0);
    expect(stdout()).toContain('LOCK');
    expect(stdout()).toContain('locked');

    logSpy.mockClear();
    expect(await run(['deployments', 'inspect', deploymentId, '--org', 'acme'], {}, home)).toBe(0);
    expect(stdout()).toContain('locked:     yes');
    expect(stdout()).toContain('admin@noodleseed.com');

    logSpy.mockClear();
    expect(
      await run(
        ['status', '--org', 'acme', '--app', app, '--env', 'prod', '--version', '1'],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('lock');
    expect(stdout()).toContain('locked');

    logSpy.mockClear();
    expect(
      await run(
        ['deploy', HELLO, '--org', 'acme', '--app', app, '--env', 'prod', '--version', '1'],
        {},
        home,
      ),
    ).toBe(1);
    expect(stderr()).toContain(
      `noodle deployments unlock --org acme --app ${app} --env prod --version 1 --yes`,
    );
  });

  it('requires confirmation to unlock non-interactively, then permits deployment', async () => {
    loggedIn();
    const app = 'dep-unlock-cli';
    const { deploymentId } = await deployHello(app);
    const lockExit = await run(
      [
        'deployments',
        'lock',
        '--org',
        'acme',
        '--app',
        app,
        '--env',
        'prod',
        '--version',
        '1',
        '--json',
      ],
      {},
      home,
    );
    expect(lockExit, stderr()).toBe(0);
    const locked = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(locked.data.deployment).toMatchObject({
      deploymentId,
      serverVersion: '1',
      locked: true,
    });

    logSpy.mockClear();
    errSpy.mockClear();
    expect(
      await run(
        [
          'deployments',
          'unlock',
          '--org',
          'acme',
          '--app',
          app,
          '--env',
          'prod',
          '--version',
          '1',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
      error: { code: 'confirmation_required' },
    });

    errSpy.mockClear();
    expect(
      await run(
        [
          'deployments',
          'unlock',
          '--org',
          'acme',
          '--app',
          app,
          '--env',
          'prod',
          '--version',
          '1',
          '--yes',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('locked:   no');

    logSpy.mockClear();
    expect(
      await run(
        ['deploy', HELLO, '--org', 'acme', '--app', app, '--env', 'prod', '--version', '1'],
        {},
        home,
      ),
    ).toBe(0);
  });
});

describe('noodle deployments (usage)', () => {
  it('exits 2 for a missing or unknown subcommand', async () => {
    expect(await run(['deployments'], {}, home)).toBe(2);
    errSpy.mockClear();
    expect(await run(['deployments', 'bogus'], {}, home)).toBe(2);
  });
});

describe('noodle list (moved — ADR 0128 D4)', () => {
  it('exits 2 with a human recovery message pointing at deployments list', async () => {
    expect(await run(['list'], {}, home)).toBe(2);
    expect(stderr()).toContain('list: `noodle list` moved. Use: noodle deployments list');
  });

  it('exits 2 with the command_moved envelope under --json', async () => {
    expect(await run(['list', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body).toEqual({
      ok: false,
      error: {
        code: 'command_moved',
        message: 'noodle list moved',
        fix: 'Use noodle deployments list',
        next: 'noodle deployments list',
      },
    });
  });
});

describe('deployment-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI DeploymentSummary render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'deployment-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as DeploymentResponse;
    const deployment: DeploymentSummary = fixture.data;
    expect(deployment).toMatchObject({
      deploymentId: 'support-bot-4f9c1a2b',
      orgSlug: 'acme',
      appSlug: 'support-bot',
      environment: 'prod',
      active: true,
      accessMode: 'org-members',
    });

    const rendered = renderDeploymentsTable([deployment], { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('support-bot-4f9c1a2b');
    expect(rendered).toContain('prod');
    expect(rendered).toContain('VERSION');
    expect(rendered).toContain('1');
    expect(rendered).toContain('active');
    expect(rendered).toContain('org-members');
  });

  it('renders an em dash for legacy deployments without serverVersion', () => {
    const deployment: DeploymentSummary = {
      deploymentId: 'legacy-bot-123',
      orgSlug: 'acme',
      appSlug: 'legacy-bot',
      environment: 'prod',
      active: true,
      serverName: 'legacy-bot',
      createdAt: new Date().toISOString(),
      accessMode: 'owner-only',
    };

    const rendered = renderDeploymentsTable([deployment], { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('VERSION');
    expect(rendered).toContain('—');
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDeployments } from '../src/commands/deployments-ops.js';
import { writeConfig } from '../src/config.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const SERVER = `
manifestVersion: '2'
server:
  name: deletion_cli
  title: Deletion CLI
  version: 1.0.0
  agentGuide:
    description: Use Deletion CLI to list records.
    useWhen: [A user asks for deletion CLI records.]
    workflows:
      - id: list_records
        title: List records
        steps: [{ capability: { kind: tool, name: list_records } }]
    boundaries: [Do not invent records.]
    examples: [{ prompt: List records., workflow: list_records }]
tools:
  - name: list_records
    description: List records.
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
        if (token !== 'admin-token') {
          return Promise.resolve({ ok: false, status: 401, message: 'missing bearer token' });
        }
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
  home = mkdtempSync(join(tmpdir(), 'noodle-deployment-deletion-cli-'));
  chdirIsolated(home);
  writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
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

async function deploy(app: string, serverVersion = '1', env = 'prod'): Promise<string> {
  const result = await service.registry.deploy({ org: 'acme', app, env }, SERVER, {
    accessMode: 'owner-only',
    serverVersion,
    actor: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`deployment fixture failed: ${result.code}`);
  return result.deploymentId;
}

async function deployLegacy(app: string, env = 'prod'): Promise<string> {
  const result = await service.registry.deploy({ org: 'acme', app, env }, SERVER, {
    accessMode: 'owner-only',
    actor: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`legacy deployment fixture failed: ${result.code}`);
  return result.deploymentId;
}

function jsonOutput(): {
  readonly ok: boolean;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly cause?: string; readonly next?: string };
} {
  return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
}

describe('noodle deployments delete', () => {
  it('requires explicit confirmation in noninteractive JSON mode', async () => {
    expect(await runDeployments(['delete', 'dep-123', '--org', 'acme', '--json'], {}, home)).toBe(
      2,
    );
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: {
        code: 'confirmation_required',
        next: 'noodle deployments delete dep-123 --org acme --yes',
      },
    });
  });

  it('permanently deletes one inactive deployment and emits the typed JSON result', async () => {
    const app = 'delete-one-cli';
    const inactive = await deploy(app);
    const active = await deploy(app);

    expect(
      await runDeployments(['delete', inactive, '--org', 'acme', '--yes', '--json'], {}, home),
    ).toBe(0);
    expect(jsonOutput()).toMatchObject({
      ok: true,
      data: {
        service: service.url,
        target: { org: 'acme', app, env: 'prod' },
        deletedDeploymentIds: [inactive],
        auditRecorded: true,
      },
    });
    expect(await service.registry.getDeployment('acme', inactive)).toBeUndefined();
    expect(await service.registry.getDeployment('acme', active)).toBeDefined();
  });

  it('preserves the active_deployment refusal and rollback recovery', async () => {
    const active = await deploy('delete-active-cli');

    expect(
      await runDeployments(['delete', active, '--org', 'acme', '--yes', '--json'], {}, home),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: { code: 'active_deployment' },
    });
    expect(jsonOutput().error?.next).toContain('noodle rollback');
  });

  it('rejects a malformed success payload through the shared client parser', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: true, deletedDeploymentIds: ['dep-123'] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );

    expect(
      await runDeployments(['delete', 'dep-123', '--org', 'acme', '--yes', '--json'], {}, home),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({ ok: false, error: { code: 'command_failed' } });
  });

  it.each([
    {
      label: 'another organization',
      target: { org: 'other', app: 'app', env: 'prod' },
      deletedDeploymentIds: ['dep-123'],
    },
    {
      label: 'another deployment id',
      target: { org: 'acme', app: 'app', env: 'prod' },
      deletedDeploymentIds: ['dep-other'],
    },
  ])('refuses schema-valid success evidence for $label', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: true,
              target: response.target,
              deletedDeploymentIds: response.deletedDeploymentIds,
              auditRecorded: true,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    expect(
      await runDeployments(['delete', 'dep-123', '--org', 'acme', '--yes', '--json'], {}, home),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: {
        code: 'deployment_delete_evidence_mismatch',
        next: 'noodle deployments list --org acme',
      },
    });
  });
});

describe('noodle deployments delete-version', () => {
  it('reads the exact inventory before returning noninteractive confirmation_required', async () => {
    const app = 'delete-version-confirm-cli';
    await deploy(app, '1');
    await deploy(app, '1');

    expect(
      await runDeployments(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod', '--json'],
        {},
        home,
      ),
    ).toBe(2);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required' },
    });
    expect(jsonOutput().error?.cause).toContain('2 deployment records');
    expect(jsonOutput().error?.cause).toContain('pinned URL offline');
  });

  it('deletes only the exact requested version and preserves 1.0.0', async () => {
    const app = 'delete-exact-version-cli';
    const first = await deploy(app, '1');
    const second = await deploy(app, '1');
    const distinct = await deploy(app, '1.0.0');

    expect(
      await runDeployments(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(jsonOutput()).toMatchObject({
      ok: true,
      data: {
        version: '1',
        target: { org: 'acme', app, env: 'prod' },
        deletedDeploymentIds: [first, second],
      },
    });
    expect(await service.registry.getDeployment('acme', first)).toBeUndefined();
    expect(await service.registry.getDeployment('acme', second)).toBeUndefined();
    expect(await service.registry.getDeployment('acme', distinct)).toBeDefined();
  });

  it('uses the reserved legacy segment for unversioned deployment history', async () => {
    const app = 'delete-legacy-version-cli';
    const legacy = await deployLegacy(app);
    const numeric = await deploy(app, '1');

    expect(
      await runDeployments(
        [
          'delete-version',
          'legacy',
          '--org',
          'acme',
          '--app',
          app,
          '--env',
          'prod',
          '--yes',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(jsonOutput()).toMatchObject({
      ok: true,
      data: { version: 'legacy', deletedDeploymentIds: [legacy] },
    });
    expect(await service.registry.getDeployment('acme', legacy)).toBeUndefined();
    expect(await service.registry.getDeployment('acme', numeric)).toBeDefined();
  });

  it('preserves deployment_locked with an exact unlock command', async () => {
    const app = 'delete-locked-version-cli';
    await deploy(app, '1');
    expect(
      await runDeployments(
        ['lock', '--org', 'acme', '--app', app, '--env', 'prod', '--version', '1', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await runDeployments(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: {
        code: 'deployment_locked',
        next: `noodle deployments unlock --org acme --app ${app} --env prod --version 1 --yes`,
      },
    });
  });

  it('preserves app_archived with restore-first recovery', async () => {
    const app = 'delete-archived-version-cli';
    await deploy(app, '1');
    expect(await service.registry.archiveApp('acme', app, new Date().toISOString())).toBeDefined();

    expect(
      await runDeployments(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: { code: 'app_archived', next: `noodle restore ${app} --org acme` },
    });
  });

  it('shows the exact target, version, count, and offline warning before an interactive refusal', async () => {
    const app = 'delete-version-prompt-cli';
    await deploy(app, '1');
    await deploy(app, '1');
    const confirm = vi.fn(() => Promise.resolve(false));
    const runner = runDeployments as unknown as (
      rest: readonly string[],
      env: NodeJS.ProcessEnv,
      home: string,
      prompts: { isInteractive(): boolean; confirm(message: string): Promise<boolean> },
    ) => Promise<number>;

    expect(
      await runner(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod'],
        {},
        home,
        { isInteractive: () => true, confirm },
      ),
    ).toBe(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0]).toContain(`acme/${app}/prod`);
    expect(confirm.mock.calls[0]?.[0]).toContain('version 1');
    expect(confirm.mock.calls[0]?.[0]).toContain('2 deployment records');
    expect(confirm.mock.calls[0]?.[0]).toContain('pinned URL offline');
  });

  it('warns that legacy deployment URLs stop instead of naming a version-pinned URL', async () => {
    const app = 'delete-legacy-prompt-cli';
    await deployLegacy(app);
    const confirm = vi.fn(() => Promise.resolve(false));
    const runner = runDeployments as unknown as (
      rest: readonly string[],
      env: NodeJS.ProcessEnv,
      home: string,
      prompts: { isInteractive(): boolean; confirm(message: string): Promise<boolean> },
    ) => Promise<number>;

    expect(
      await runner(
        ['delete-version', 'legacy', '--org', 'acme', '--app', app, '--env', 'prod'],
        {},
        home,
        { isInteractive: () => true, confirm },
      ),
    ).toBe(2);
    expect(confirm.mock.calls[0]?.[0]).toContain('deployment URLs stop working immediately');
    expect(confirm.mock.calls[0]?.[0]).not.toContain('pinned URL');
  });

  it.each([
    {
      label: 'another target',
      target: { org: 'acme', app: 'other', env: 'prod' },
      deletedDeploymentIds: ['dep-inventory'],
    },
    {
      label: 'another inventory',
      target: { org: 'acme', app: 'app', env: 'prod' },
      deletedDeploymentIds: ['dep-other'],
    },
  ])('refuses schema-valid version success evidence for $label', async (response) => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        const body =
          method === 'GET'
            ? {
                ok: true,
                deployments: [
                  {
                    deploymentId: 'dep-inventory',
                    orgSlug: 'acme',
                    appSlug: 'app',
                    environment: 'prod',
                    active: true,
                    serverName: 'app',
                    serverVersion: '1',
                    createdAt: '2026-09-14T00:00:00.000Z',
                    accessMode: 'owner-only',
                  },
                ],
              }
            : {
                ok: true,
                target: response.target,
                deletedDeploymentIds: response.deletedDeploymentIds,
                auditRecorded: true,
              };
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );

    expect(
      await runDeployments(
        [
          'delete-version',
          '1',
          '--org',
          'acme',
          '--app',
          'app',
          '--env',
          'prod',
          '--yes',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: {
        code: 'deployment_delete_evidence_mismatch',
        next: 'noodle deployments list --org acme --app app --env prod',
      },
    });
  });

  it('returns deployment_delete_conflict without partially deleting a raced inventory', async () => {
    const app = 'delete-version-race-cli';
    const first = await deploy(app, '1');
    const originalFetch = globalThis.fetch;
    let raced: string | undefined;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (
        raced === undefined &&
        (init?.method ?? 'GET') === 'GET' &&
        url.pathname === '/v1/orgs/acme/deployments'
      ) {
        raced = await deploy(app, '1');
      }
      return response;
    });

    expect(
      await runDeployments(
        ['delete-version', '1', '--org', 'acme', '--app', app, '--env', 'prod', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(1);
    expect(jsonOutput()).toMatchObject({
      ok: false,
      error: { code: 'deployment_delete_conflict' },
    });
    expect(await service.registry.getDeployment('acme', first)).toBeDefined();
    expect(await service.registry.getDeployment('acme', raced as string)).toBeDefined();
  });
});

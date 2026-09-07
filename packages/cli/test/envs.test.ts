import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderEnvsTable } from '../src/commands/envs-ops.js';
import type { EnvResponse, EnvSummary } from '../src/commands/resource-shared.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle envs list` / `noodle envs inspect` verified against a real service instance — same
 * pattern as `apps.test.ts`: an in-process service with a superAdmin deploy gate, seeded by running
 * the CLI's own `deploy` command against a fixture server.
 */

const HELLO = join(import.meta.dirname, 'fixtures', 'archive-hello-server.ts');

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
  home = mkdtempSync(join(tmpdir(), 'noodle-envs-cli-'));
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

function loggedIn(org = 'acme'): void {
  writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: org }, home);
}

async function deployHello(app: string, targetEnv = 'prod'): Promise<void> {
  expect(
    await run(
      ['deploy', HELLO, '--org', 'acme', '--app', app, '--env', targetEnv, '--version', '1'],
      {},
      home,
    ),
  ).toBe(0);
  logSpy.mockClear();
}

describe('noodle envs list', () => {
  it('renders a table with env rows for a deployed app', async () => {
    loggedIn();
    await deployHello('envs-list-cli', 'prod');
    await deployHello('envs-list-cli', 'staging');

    expect(await run(['envs', 'list', '--org', 'acme', '--app', 'envs-list-cli'], {}, home)).toBe(
      0,
    );
    const out = stdout();
    expect(out).toContain('prod');
    expect(out).toContain('staging');
    expect(out).toContain('active');
    expect(out).toContain('production');
  });

  it('emits exactly {ok:true,data:{envs}} under --json', async () => {
    loggedIn();
    await deployHello('envs-json-cli');

    expect(
      await run(['envs', 'list', '--org', 'acme', '--app', 'envs-json-cli', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(['envs']);
    expect(body.data.envs.some((e: EnvSummary) => e.envName === 'prod')).toBe(true);
  });

  it('--archived includes envs of an archived app that the default list hides', async () => {
    loggedIn();
    await deployHello('envs-archive-cli');
    expect(await run(['archive', 'envs-archive-cli', '--org', 'acme', '--yes'], {}, home)).toBe(0);
    logSpy.mockClear();

    expect(
      await run(['envs', 'list', '--org', 'acme', '--app', 'envs-archive-cli', '--json'], {}, home),
    ).toBe(0);
    const hidden = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(hidden.data.envs.length).toBe(0);
    logSpy.mockClear();

    expect(
      await run(
        ['envs', 'list', '--org', 'acme', '--app', 'envs-archive-cli', '--archived', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const shown = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    const found = shown.data.envs.find((e: EnvSummary) => e.envName === 'prod');
    expect(found).toBeDefined();
    expect(found.archivedAt).toEqual(expect.any(String));
  });

  it('prints a friendly empty-state message when the default (non-archived) view has no envs', async () => {
    // The in-memory store has no "app exists but zero envs" state reachable without a deploy
    // (see EnvSummary's doc comment in packages/service/src/store.ts: that empty-anchor state is
    // Postgres-only). Archiving the app's only env hits the same zero-row render path instead.
    loggedIn();
    await deployHello('envs-empty-view-cli');
    expect(await run(['archive', 'envs-empty-view-cli', '--org', 'acme', '--yes'], {}, home)).toBe(
      0,
    );
    logSpy.mockClear();

    expect(
      await run(['envs', 'list', '--org', 'acme', '--app', 'envs-empty-view-cli'], {}, home),
    ).toBe(0);
    expect(stdout()).toContain('No environments for acme/envs-empty-view-cli');
  });

  it('exits 2 when org or app is missing from flag, config, or link', async () => {
    loggedIn();
    expect(await run(['envs', 'list'], {}, home)).toBe(2);
  });

  it('exits 1 with a friendly not-found for an unknown app', async () => {
    loggedIn();
    expect(
      await run(['envs', 'list', '--org', 'acme', '--app', 'ghost-app-cli', '--json'], {}, home),
    ).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('not_found');
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.next).toBe(
      'noodle apps list --org acme',
    );
  });
});

describe('noodle envs inspect', () => {
  it('renders a compact detail block for a known env', async () => {
    loggedIn();
    await deployHello('envs-inspect-cli', 'prod');

    expect(
      await run(
        ['envs', 'inspect', 'prod', '--org', 'acme', '--app', 'envs-inspect-cli'],
        {},
        home,
      ),
    ).toBe(0);
    const out = stdout();
    expect(out).toContain('prod');
    expect(out).toContain('acme');
    expect(out).toContain('envs-inspect-cli');
    expect(out).toContain('production: yes');
  });

  it('emits the EnvSummary under --json', async () => {
    loggedIn();
    await deployHello('envs-inspect-json-cli', 'staging');

    expect(
      await run(
        ['envs', 'inspect', 'staging', '--org', 'acme', '--app', 'envs-inspect-json-cli', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(true);
    expect(body.data.envName).toBe('staging');
    expect(body.data.appSlug).toBe('envs-inspect-json-cli');
  });

  it('exits 1 with a friendly not-found for an unknown env', async () => {
    loggedIn();
    await deployHello('envs-inspect-ghost-cli', 'prod');

    expect(
      await run(
        [
          'envs',
          'inspect',
          'ghost-env',
          '--org',
          'acme',
          '--app',
          'envs-inspect-ghost-cli',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('not_found');
    expect(body.error.next).toBe('noodle envs list --org acme --app envs-inspect-ghost-cli');
  });

  it('exits 2 when no env is given', async () => {
    loggedIn();
    expect(
      await run(['envs', 'inspect', '--org', 'acme', '--app', 'envs-inspect-cli'], {}, home),
    ).toBe(2);
  });
});

describe('noodle envs set-production', () => {
  it('reassigns production and exposes the designation in human and JSON output', async () => {
    loggedIn();
    await deployHello('envs-production-cli', 'prod');
    await deployHello('envs-production-cli', 'happy-hour');

    expect(
      await run(
        ['envs', 'set-production', 'happy-hour', '--org', 'acme', '--app', 'envs-production-cli'],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('happy-hour is now the production environment');
    logSpy.mockClear();

    expect(
      await run(
        [
          'envs',
          'set-production',
          'happy-hour',
          '--org',
          'acme',
          '--app',
          'envs-production-cli',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data).toMatchObject({
      productionEnvironment: 'happy-hour',
      previousProductionEnvironment: 'happy-hour',
      changed: false,
    });
  });

  it('returns a friendly not-found for an unknown environment', async () => {
    loggedIn();
    await deployHello('envs-production-missing-cli', 'prod');
    expect(
      await run(
        [
          'envs',
          'set-production',
          'ghost',
          '--org',
          'acme',
          '--app',
          'envs-production-missing-cli',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('not_found');
  });
});

describe('noodle envs (usage)', () => {
  it('exits 2 for a missing or unknown subcommand', async () => {
    expect(await run(['envs'], {}, home)).toBe(2);
    errSpy.mockClear();
    expect(await run(['envs', 'bogus'], {}, home)).toBe(2);
  });
});

describe('envs-list-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI EnvSummary render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'envs-list-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      readonly ok: true;
      readonly data: { readonly envs: readonly EnvSummary[] };
    };
    const envs: readonly EnvSummary[] = fixture.data.envs;
    expect(envs[0]).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'support-bot',
      envName: 'prod',
      isProduction: true,
      active: true,
      deploymentCount: 5,
    });
    expect(envs[1]).toMatchObject({
      envName: 'staging',
      isProduction: false,
      active: false,
      deploymentCount: 0,
    });

    const rendered = renderEnvsTable(envs, { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('prod');
    expect(rendered).toContain('staging');
    expect(rendered).toContain('active');
    expect(rendered).toContain('no deploys');
  });
});

describe('env-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI EnvSummary render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'env-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as EnvResponse;
    const env: EnvSummary = fixture.data;
    expect(env).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'support-bot',
      envName: 'prod',
      isProduction: true,
      active: true,
      deploymentCount: 5,
      accessMode: 'org-members',
    });

    const rendered = renderEnvsTable([env], { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('prod');
    expect(rendered).toContain('active');
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { appsListFrame, renderAppsTable } from '../src/commands/apps-ops.js';
import type { AppResponse, AppSummary } from '../src/commands/resource-shared.js';
import { run, writeConfig } from '../src/index.js';
import { relativeTime } from '../src/relative-time.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle apps list` / `noodle apps inspect` verified against a real service instance — same
 * pattern as `archive-ops.test.ts`: an in-process service with a superAdmin deploy gate, seeded by
 * running the CLI's own `deploy` command against a fixture server.
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
  home = mkdtempSync(join(tmpdir(), 'noodle-apps-cli-'));
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

describe('noodle apps list', () => {
  it('renders a table with app slugs and env names', async () => {
    loggedIn();
    await deployHello('support-bot-cli', 'prod');
    await deployHello('support-bot-cli', 'staging');

    expect(await run(['apps', 'list', '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain('support-bot-cli');
    expect(out).toContain('prod');
    expect(out).toContain('staging');
  });

  it('emits exactly {ok:true,data:{apps,truncated}} under --json', async () => {
    loggedIn();
    await deployHello('json-app-cli');

    expect(await run(['apps', 'list', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.ok).toBe(true);
    expect(Object.keys(body.data).sort()).toEqual(['apps', 'truncated']);
    expect(typeof body.data.truncated).toBe('boolean');
    expect(body.data.apps.some((a: AppSummary) => a.appSlug === 'json-app-cli')).toBe(true);
  });

  it('--archived includes archived apps that the default list hides', async () => {
    loggedIn();
    await deployHello('to-archive-cli');
    expect(await run(['archive', 'to-archive-cli', '--org', 'acme', '--yes'], {}, home)).toBe(0);
    logSpy.mockClear();

    expect(await run(['apps', 'list', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const hidden = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(hidden.data.apps.some((a: AppSummary) => a.appSlug === 'to-archive-cli')).toBe(false);
    logSpy.mockClear();

    expect(await run(['apps', 'list', '--org', 'acme', '--archived', '--json'], {}, home)).toBe(0);
    const shown = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    const found = shown.data.apps.find((a: AppSummary) => a.appSlug === 'to-archive-cli');
    expect(found).toBeDefined();
    expect(found.archivedAt).toEqual(expect.any(String));
  });

  it('prints a friendly empty-state message when the org has no apps', async () => {
    loggedIn('empty-org-cli');
    expect(await run(['apps', 'list'], {}, home)).toBe(0);
    expect(stdout()).toContain('No apps in empty-org-cli');
  });

  it('respects --json for the empty-state case too', async () => {
    loggedIn('empty-org-json-cli');
    expect(await run(['apps', 'list', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { apps: [], truncated: false },
    });
  });

  it('exits 2 when no org is available from flag, config, or link', async () => {
    expect(await run(['apps', 'list'], {}, home)).toBe(2);
  });

  it('--watch combined with --json is a usage error, not a silent pick of one', async () => {
    loggedIn();
    expect(await run(['apps', 'list', '--org', 'acme', '--watch', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.error.code).toBe('watch_json_conflict');
  });
});

describe('appsListFrame — the fetch+render --watch polls', () => {
  it('renders the same table content the one-shot list prints', async () => {
    loggedIn();
    await deployHello('watch-frame-cli');
    const resolved = { serviceUrl: service.url, token: 'admin-token' };
    const result = await appsListFrame(resolved.serviceUrl, resolved.token, 'acme', false);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.frame).toContain('watch-frame-cli');
  });

  it('resolves a CliFailure (not a throw) when the fetch fails', async () => {
    const result = await appsListFrame('http://127.0.0.1:1', undefined, 'acme', false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBeDefined();
  });
});

describe('noodle apps inspect', () => {
  it('renders a compact detail block for a known app', async () => {
    loggedIn();
    await deployHello('inspect-me-cli');

    expect(await run(['apps', 'inspect', 'inspect-me-cli', '--org', 'acme'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain('inspect-me-cli');
    expect(out).toContain('acme');
  });

  it('emits the AppSummary under --json', async () => {
    loggedIn();
    await deployHello('inspect-json-cli');

    expect(
      await run(['apps', 'inspect', 'inspect-json-cli', '--org', 'acme', '--json'], {}, home),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
    expect(body.ok).toBe(true);
    expect(body.data.appSlug).toBe('inspect-json-cli');
  });

  it('exits 1 with a friendly not-found for an unknown app', async () => {
    loggedIn();
    expect(
      await run(['apps', 'inspect', 'ghost-app-cli', '--org', 'acme', '--json'], {}, home),
    ).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('not_found');
  });

  it('exits 2 with plain usage when no app is given (non-interactive: no picker fires)', async () => {
    loggedIn();
    expect(await run(['apps', 'inspect', '--org', 'acme'], {}, home)).toBe(2);
  });
});

describe('noodle apps open', () => {
  it('--print prints the same endpoint URL `noodle open --print` would for the linked project', async () => {
    loggedIn();
    await run(
      ['deploy', HELLO, '--org', 'acme', '--app', 'open-me-cli', '--version', '1'],
      {},
      home,
    );
    const deployed = /Endpoint:\s+(\S+)/.exec(stdout())?.[1];
    expect(deployed).toBeDefined();
    logSpy.mockClear();

    expect(await run(['apps', 'open', 'open-me-cli', '--org', 'acme', '--print'], {}, home)).toBe(
      0,
    );
    expect(stdout().trim()).toBe(deployed);
  });

  it('--env picks a specific environment instead of the facing (latest) one', async () => {
    loggedIn();
    await run(
      [
        'deploy',
        HELLO,
        '--org',
        'acme',
        '--app',
        'open-env-cli',
        '--env',
        'prod',
        '--version',
        '1',
      ],
      {},
      home,
    );
    logSpy.mockClear();
    await run(
      [
        'deploy',
        HELLO,
        '--org',
        'acme',
        '--app',
        'open-env-cli',
        '--env',
        'staging',
        '--version',
        '1',
      ],
      {},
      home,
    );
    const stagingUrl = /Endpoint:\s+(\S+)/.exec(stdout())?.[1];
    expect(stagingUrl).toBeDefined();
    logSpy.mockClear();

    expect(
      await run(
        ['apps', 'open', 'open-env-cli', '--org', 'acme', '--env', 'staging', '--print'],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout().trim()).toBe(stagingUrl);
  });

  it('exits 1 with a friendly not-found for an unknown app', async () => {
    loggedIn();
    expect(await run(['apps', 'open', 'ghost-open-cli', '--org', 'acme', '--json'], {}, home)).toBe(
      1,
    );
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('not_found');
  });
});

describe('noodle apps (usage)', () => {
  it('exits 2 for a missing or unknown subcommand', async () => {
    expect(await run(['apps'], {}, home)).toBe(2);
    errSpy.mockClear();
    expect(await run(['apps', 'bogus'], {}, home)).toBe(2);
  });
});

describe('apps-list-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI AppSummary render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'apps-list-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      readonly ok: true;
      readonly data: { readonly apps: readonly AppSummary[]; readonly truncated: boolean };
    };
    const apps: readonly AppSummary[] = fixture.data.apps;
    expect(apps[0]).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'support-bot',
      environments: ['prod', 'staging'],
      active: true,
    });
    expect(apps[1]).toMatchObject({ appSlug: 'legacy-importer', environments: [], active: false });

    const rendered = renderAppsTable(apps, { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('support-bot');
    expect(rendered).toContain('legacy-importer');
    expect(rendered).toContain('prod, staging');
  });
});

describe('app-response.json contract drift gate', () => {
  it('feeds the golden fixture through the CLI AppSummary render without shape drift', () => {
    const fixturePath = join(
      import.meta.dirname,
      '..',
      '..',
      '..',
      'contract',
      'v1',
      'app-response.json',
    );
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AppResponse;
    const app: AppSummary = fixture.data;
    expect(app).toMatchObject({
      orgSlug: 'acme',
      appSlug: 'support-bot',
      environments: ['prod', 'staging'],
      active: true,
      accessMode: 'org-members',
    });

    const rendered = renderAppsTable([app], { color: 'none', glyph: 'unicode' });
    expect(rendered).toContain('support-bot');
    expect(rendered).toContain('prod, staging');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-05T12:00:00.000Z');

  it('formats sub-minute deltas as "just now"', () => {
    expect(relativeTime('2026-07-05T11:59:50.000Z', now)).toBe('just now');
  });

  it('formats minutes, hours, and days ago', () => {
    expect(relativeTime('2026-07-05T11:58:00.000Z', now)).toBe('2m ago');
    expect(relativeTime('2026-07-05T10:00:00.000Z', now)).toBe('2h ago');
    expect(relativeTime('2026-06-19T12:00:00.000Z', now)).toBe('16d ago');
  });

  it('formats months and years ago', () => {
    expect(relativeTime('2026-01-05T12:00:00.000Z', now)).toBe('6mo ago');
    expect(relativeTime('2024-07-05T12:00:00.000Z', now)).toBe('2y ago');
  });
});

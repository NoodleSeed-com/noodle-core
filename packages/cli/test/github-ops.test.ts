import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoConnection } from '@noodle-borg/wire-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGithub, runGithubConnect } from '../src/commands/github-ops.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle github connect|status|disconnect` verified against its HTTP contract. `connect` is exercised
 * through `runGithubConnect` directly so the browser-open seam can land the synthetic Setup URL and
 * make the first poll resolve without depending on commercial service implementation.
 */

const SERVICE = 'https://service.example';

type Repository = {
  readonly id: number;
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
};

const DEFAULT_REPOSITORIES: Record<number, readonly Repository[]> = {
  111: [
    {
      id: 1001,
      fullName: 'acme-gh/widgets',
      owner: 'acme-gh',
      name: 'widgets',
      defaultBranch: 'main',
      private: false,
    },
    {
      id: 1002,
      fullName: 'acme-gh/other',
      owner: 'acme-gh',
      name: 'other',
      defaultBranch: 'main',
      private: false,
    },
  ],
};

let repositoriesByInstallation: Record<number, readonly Repository[]>;
let connections: Map<string, RepoConnection>;
let pendingInstallation: number | undefined;
let offline: boolean;
let stateSequence: number;

let service: { readonly url: string; close(): Promise<void> };
let home: string;
let outSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

async function boot(
  repositories: Record<number, readonly Repository[]> = DEFAULT_REPOSITORIES,
): Promise<void> {
  repositoriesByInstallation = repositories;
  connections = new Map();
  pendingInstallation = undefined;
  offline = false;
  stateSequence = 0;
  service = {
    url: SERVICE,
    close: async () => {
      offline = true;
    },
  };
  vi.stubGlobal('fetch', fakeGithubFetch);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function fakeGithubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (offline) throw new TypeError('fetch failed');
  const url = new URL(input.toString());
  const method = init?.method ?? 'GET';
  const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');

  if (url.pathname === '/v1/github/setup') {
    pendingInstallation = Number(url.searchParams.get('installation_id'));
    return new Response('installed');
  }
  if (url.pathname === '/v1/github/install-url') {
    const state = `state-${++stateSequence}`;
    return json({
      ok: true,
      data: {
        installUrl: `https://github.com/apps/noodle-seed-deploys/installations/new?state=${state}`,
        state,
      },
    });
  }
  if (url.pathname === '/v1/github/installations/pending') {
    return pendingInstallation === undefined
      ? json({ error: 'pending installation not found' }, 404)
      : json({ ok: true, data: { installationId: pendingInstallation } });
  }
  if (url.pathname === '/v1/github/installations/claim' && method === 'POST') {
    if (token === 'member-token') return json({ error: 'org owner required' }, 403);
    const installationId = pendingInstallation ?? 111;
    return json({
      ok: true,
      data: {
        installationId,
        repositories: repositoriesByInstallation[installationId] ?? [],
      },
    });
  }

  const connection = /^\/v1\/orgs\/([^/]+)\/apps\/([^/]+)\/github\/connection$/.exec(url.pathname);
  if (connection !== null) {
    const [, orgSlug = '', appSlug = ''] = connection;
    const key = `${orgSlug}/${appSlug}`;
    if (method === 'GET') {
      const record = connections.get(key);
      return record === undefined
        ? json({ error: 'connection not found' }, 404)
        : json({ ok: true, data: record });
    }
    if (method === 'DELETE') {
      const disabled = connections.delete(key);
      return json({ ok: true, data: { disabled } });
    }
    if (token === 'member-token') return json({ error: 'org owner required' }, 403);
    const request = JSON.parse(String(init?.body)) as {
      installationId: number;
      githubRepositoryId: number;
    };
    const conflict = [...connections.values()].find(
      (record) =>
        record.githubRepositoryId === request.githubRepositoryId && record.appSlug !== appSlug,
    );
    if (conflict !== undefined) return json({ error: 'repository is already connected' }, 409);
    const repository = (repositoriesByInstallation[request.installationId] ?? []).find(
      (candidate) => candidate.id === request.githubRepositoryId,
    );
    if (repository === undefined) return json({ error: 'repository not found' }, 404);
    const now = '2026-07-06T09:30:00.000Z';
    const record: RepoConnection = {
      orgSlug,
      appSlug,
      installationId: request.installationId,
      githubRepositoryId: repository.id,
      repoName: repository.fullName,
      defaultBranch: repository.defaultBranch,
      createdAt: now,
      updatedAt: now,
    };
    connections.set(key, record);
    return json({ ok: true, data: record });
  }

  if (/\/github\/runs$/.test(url.pathname)) {
    return json({ ok: true, data: { runs: [], truncated: false } });
  }
  return json({ error: `unhandled test request: ${method} ${url.pathname}` }, 500);
}

let stdoutLines: string[];
let stderrLines: string[];
let writeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'noodle-github-cli-'));
  chdirIsolated(home);
  stdoutLines = [];
  stderrLines = [];
  // Most output is plain `console.log`/`console.error` (matches every other CLI test in this repo), but
  // `printStep` (status.ts) writes its ✔/✗ lines directly via `process.stdout.write` — spy on all three,
  // pushing into the same ordered buffers, so both styles of output are captured uniformly.
  outSpy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
    stdoutLines.push(String(msg));
  });
  errSpy = vi.spyOn(console, 'error').mockImplementation((msg?: unknown) => {
    stderrLines.push(String(msg));
  });
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  await boot();
});

afterEach(async () => {
  restoreCwd();
  outSpy.mockRestore();
  errSpy.mockRestore();
  writeSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  await service.close();
});

function stdout(): string {
  return stdoutLines.join('\n');
}

function resetOutput(): void {
  stdoutLines.length = 0;
  stderrLines.length = 0;
}

function loggedIn(token: string): void {
  writeConfig({ serviceUrl: service.url, authToken: token }, home);
}

/** The fake "browser": extracts `state` from the install URL and lands it on our own Setup URL route. */
function landingOpener(installationId = 111): (url: string) => Promise<void> {
  return async (url: string) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    const res = await fetch(
      `${service.url}/v1/github/setup?installation_id=${installationId}&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(200);
  };
}

async function seedConnection(app: string): Promise<void> {
  const res = await fetch(`${service.url}/v1/orgs/acme/apps/${app}/github/connection`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
    body: JSON.stringify({ installationId: 111, githubRepositoryId: 1001 }),
  });
  expect(res.status).toBe(200);
}

describe('noodle github connect', () => {
  it('happy path with --repo: opens the browser, polls, claims, and connects', async () => {
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/widgets', '--org', 'acme', '--app', 'support-bot'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(0);
    const out = stdout();
    expect(out).toContain('Connected acme-gh/widgets → acme/support-bot');
    expect(out).toContain('repo:');
    expect(out).toContain('acme-gh/widgets');
    expect(out).toContain('main → prod');
    expect(out).toContain('noodle github status');
  });

  it('--json emits the connection record', async () => {
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/widgets', '--org', 'acme', '--app', 'json-app', '--json'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(true);
    expect(body.data.repoName).toBe('acme-gh/widgets');
    expect(body.data.githubRepositoryId).toBe(1001);
  });

  it('auto-selects when the installation has exactly one repository', async () => {
    await service.close();
    await boot({
      111: [
        {
          id: 2001,
          fullName: 'acme-gh/solo',
          owner: 'acme-gh',
          name: 'solo',
          defaultBranch: 'main',
          private: false,
        },
      ],
    });
    loggedIn('owner-token');
    const code = await runGithubConnect(['--org', 'acme', '--app', 'solo-app'], {}, home, {
      openBrowser: landingOpener(),
    });
    expect(code).toBe(0);
    expect(stdout()).toContain('acme-gh/solo');
  });

  it('multiple repos without --repo, under --json, fails with missing_answer (exit 2)', async () => {
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--org', 'acme', '--app', 'multi-app', '--json'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(2);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('missing_answer');
  });

  it('a non-owner member gets a 403 recovery (exit 3) naming an org owner', async () => {
    loggedIn('member-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/widgets', '--org', 'acme', '--app', 'forbidden-app', '--json'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(3);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(body.error.next).toBe('noodle members list --org acme');
  });

  it('409s connecting an already-connected repository to a different app, with a status-naming recovery', async () => {
    await seedConnection('already-connected-app');
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/widgets', '--org', 'acme', '--app', 'second-app', '--json'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(1);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(body.error.next).toContain('noodle github status');
  });

  it('an unmatched --repo fails with a not_found recovery', async () => {
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/does-not-exist', '--org', 'acme', '--app', 'unmatched-app', '--json'],
      {},
      home,
      { openBrowser: landingOpener() },
    );
    expect(code).toBe(1);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('not_found');
  });

  it('a poll transport failure surfaces as a polished CLI failure, not an unhandled throw', async () => {
    loggedIn('owner-token');
    const code = await runGithubConnect(
      ['--repo', 'acme-gh/widgets', '--org', 'acme', '--app', 'poll-crash-app', '--json'],
      {},
      home,
      {
        // The "browser" takes the whole service down before the poll's first request, so the poll's
        // fetch rejects with a raw network error — it must come back through the same
        // printCliFailure envelope every other network step in this flow uses.
        openBrowser: async () => {
          await service.close();
        },
      },
    );
    expect(code).not.toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(false);
    expect(typeof body.error.code).toBe('string');
    await boot(); // afterEach closes `service` — hand it a live one to close
  });
});

describe('noodle github status', () => {
  it('reports the connected block as a detail card with the repo title and NEXT footer', async () => {
    await seedConnection('status-app');
    loggedIn('owner-token');
    expect(await run(['github', 'status', '--org', 'acme', '--app', 'status-app'], {}, home)).toBe(
      0,
    );
    const out = stdout();
    expect(out.split('\n')[0]).toBe('acme-gh/widgets');
    expect(out).toMatch(/target\s+acme\/status-app/);
    expect(out).toMatch(/branch\s+main → prod/);
    expect(out).toMatch(/state\s+● connected/);
    expect(out).toMatch(/installation\s+111/);
    expect(out).toMatch(/last run\s+/);
    expect(out).toContain('NEXT');
    expect(out).toContain('noodle github runs');
  });

  it('--json reports connected:true with the connection record', async () => {
    await seedConnection('status-json-app');
    loggedIn('owner-token');
    expect(
      await run(
        ['github', 'status', '--org', 'acme', '--app', 'status-json-app', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(true);
    expect(body.data.connected).toBe(true);
    expect(body.data.connection.repoName).toBe('acme-gh/widgets');
  });

  it('reports not-connected as a friendly, non-error exit 0 card', async () => {
    loggedIn('owner-token');
    expect(
      await run(['github', 'status', '--org', 'acme', '--app', 'never-connected'], {}, home),
    ).toBe(0);
    const out = stdout();
    expect(out.split('\n')[0]).toBe('acme/never-connected');
    expect(out).toMatch(/state\s+not connected/);
    expect(out).toContain('noodle github connect');
  });

  it('--json reports connected:false when nothing is connected', async () => {
    loggedIn('owner-token');
    expect(
      await run(
        ['github', 'status', '--org', 'acme', '--app', 'never-connected-json', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout())).toEqual({ ok: true, data: { connected: false } });
  });
});

describe('noodle github disconnect', () => {
  it('--yes disconnects headlessly and is idempotent on repeat', async () => {
    await seedConnection('disconnect-app');
    loggedIn('owner-token');
    const first = await run(
      ['github', 'disconnect', '--org', 'acme', '--app', 'disconnect-app', '--yes'],
      {},
      home,
    );
    expect(first).toBe(0);
    resetOutput();

    const second = await run(
      ['github', 'disconnect', '--org', 'acme', '--app', 'disconnect-app', '--yes', '--json'],
      {},
      home,
    );
    expect(second).toBe(0);
    const body = JSON.parse(stdout());
    expect(body.ok).toBe(true);
  });

  it('without --yes and non-interactive, requires confirmation (exit 2)', async () => {
    await seedConnection('confirm-app');
    loggedIn('owner-token');
    const code = await run(
      ['github', 'disconnect', '--org', 'acme', '--app', 'confirm-app'],
      {},
      home,
    );
    expect(code).toBe(2);
  });
});

describe('github catalog completeness', () => {
  it('noodle github --help lists connect/status/disconnect', async () => {
    expect(await run(['github', '--help'], {}, home)).toBe(0);
    const out = stdout();
    expect(out).toContain('connect');
    expect(out).toContain('status');
    expect(out).toContain('disconnect');
  });

  it('bare `noodle github` prints help and exits 2', async () => {
    expect(await run(['github'], {}, home)).toBe(2);
  });

  it('runGithub falls through to a usage error for an unknown subcommand called directly', async () => {
    const code = await runGithub(['bogus'], {}, home);
    expect(code).toBe(2);
  });
});

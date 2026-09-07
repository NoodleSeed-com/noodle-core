import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'archive-hello-server.ts');

// One service is shared across tests (like the other hosted-ops suites), so each test uses its own
// app slug and app-scoped list filters to stay independent.
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
  home = mkdtempSync(join(tmpdir(), 'noodle-archive-cli-'));
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

function loggedIn(): void {
  writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
}

async function deployHello(app: string): Promise<{ url: string }> {
  expect(
    await run(['deploy', HELLO, '--org', 'acme', '--app', app, '--version', '1'], {}, home),
  ).toBe(0);
  const url = /Endpoint:\s+(\S+)/.exec(stdout())?.[1];
  expect(url).toBeDefined();
  logSpy.mockClear();
  return { url: url as string };
}

function initialize(url: string): Promise<Response> {
  return fetch(url, {
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
}

async function listApp(app: string, archived: boolean): Promise<{ archivedAt?: string }[]> {
  const args = ['deployments', 'list', '--org', 'acme', '--app', app, '--json'];
  if (archived) args.splice(2, 0, '--archived');
  expect(await run(args, {}, home)).toBe(0);
  const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
    data: { deployments: { archivedAt?: string }[] };
  };
  logSpy.mockClear();
  return body.data.deployments;
}

describe('noodle archive / restore / list --archived', () => {
  it('requires confirmation when not interactive: --yes is mandatory in JSON mode', async () => {
    loggedIn();
    expect(await run(['archive', 'anyapp', '--org', 'acme', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: false;
      error: { code: string; next: string };
    };
    expect(body.error.code).toBe('confirmation_required');
    expect(body.error.next).toContain('--yes');
  });

  it('rejects --env: archive always applies to the whole app', async () => {
    loggedIn();
    expect(
      await run(
        ['archive', 'anyapp', '--org', 'acme', '--env', 'prod', '--yes', '--json'],
        {},
        home,
      ),
    ).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('usage_error');
  });

  it('archives the whole app, hides it from list, and turns its endpoint into 410', async () => {
    loggedIn();
    const { url } = await deployHello('arch-a');

    expect(await run(['archive', 'arch-a', '--org', 'acme', '--yes', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: true;
      target: { org: string; app: string };
      archive: { archivedAt: string; archivedDeployments: number; alreadyArchived: boolean };
      service: string;
    };
    expect(body.ok).toBe(true);
    expect(body.data.target).toEqual({ org: 'acme', app: 'arch-a' });
    expect(body.data.archive.archivedDeployments).toBe(1);
    expect(body.data.archive.alreadyArchived).toBe(false);
    expect(body.data.service).toBe(service.url);
    logSpy.mockClear();

    // Hidden from the default list; visible with --archived, carrying archivedAt.
    expect(await listApp('arch-a', false)).toHaveLength(0);
    const archived = await listApp('arch-a', true);
    expect(archived).toHaveLength(1);
    expect(archived[0]?.archivedAt).toBe(body.data.archive.archivedAt);

    // The data plane answers 410 Gone while archived.
    expect((await initialize(url)).status).toBe(410);
  });

  it('restores the app so it lists and serves again', async () => {
    loggedIn();
    const { url } = await deployHello('arch-b');
    expect(await run(['archive', 'arch-b', '--org', 'acme', '--yes'], {}, home)).toBe(0);
    logSpy.mockClear();

    expect(await run(['restore', 'arch-b', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: true;
      restore: { restoredDeployments: number; alreadyActive: boolean };
    };
    expect(body.data.restore).toEqual({ restoredDeployments: 1, alreadyActive: false });
    logSpy.mockClear();

    expect(await listApp('arch-b', false)).toHaveLength(1);
    // No longer 410; owner-only auth applies again (this harness verifies no owner tokens → 401).
    expect((await initialize(url)).status).toBe(401);
  });

  it('prints human-readable confirmation with next steps outside JSON mode', async () => {
    loggedIn();
    await deployHello('arch-c');
    expect(await run(['archive', 'arch-c', '--org', 'acme', '--yes'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('target:  acme/arch-c');
    expect(printed).toContain('archived:');
    expect(printed).toContain('noodle restore arch-c');
  });

  it('fails with the service error for an unknown app', async () => {
    loggedIn();
    expect(await run(['archive', 'ghost', '--org', 'acme', '--yes', '--json'], {}, home)).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('service_error');
    logSpy.mockClear();
    errSpy.mockClear();
    expect(await run(['restore', 'ghost', '--org', 'acme', '--json'], {}, home)).toBe(1);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('service_error');
  });

  it('requires a login token with the shared auth exit contract', async () => {
    writeConfig({ serviceUrl: service.url, defaultOrg: 'acme' }, home);
    expect(await run(['archive', 'anyapp', '--org', 'acme', '--yes', '--json'], {}, home)).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('auth_required');
    logSpy.mockClear();
    errSpy.mockClear();
    expect(await run(['restore', 'anyapp', '--org', 'acme', '--json'], {}, home)).toBe(3);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe('auth_required');
  });
});

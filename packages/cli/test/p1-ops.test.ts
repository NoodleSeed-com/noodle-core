import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { statusFrame } from '../src/commands/deploy-status-ops.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const HELLO = join(import.meta.dirname, 'fixtures', 'hello', 'server.ts');

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
  home = mkdtempSync(join(tmpdir(), 'noodle-p1-cli-'));
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

describe('P1 hosted operations CLI', () => {
  it('prints deployments list JSON for a deployed app (moved from `noodle list`, ADR 0128 D4)', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['deployments', 'list', '--org', 'acme', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: true;
      data: { deployments: unknown[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.deployments.length).toBe(1);
  });

  it('shows hosted status using linked or saved target defaults', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await run(['status', '--org', 'acme', '--app', 'hello', '--env', 'prod'], {}, home),
    ).toBe(0);
    const printed = stdout();
    // Detail card: org/app/env title, aligned rows, dim service provenance, NEXT footer.
    expect(printed.split('\n')[0]).toBe('acme/hello/prod');
    expect(printed).toMatch(/deployment\s+\S+/);
    expect(printed).toMatch(/state\s+● active/);
    expect(printed).toMatch(/access\s+owner-only/);
    expect(printed).toMatch(/health\s+ready/);
    expect(printed).toContain(service.url);
    expect(printed).toContain('NEXT');
    expect(printed).toContain('noodle logs --tail');
    expect(printed).toContain('noodle metrics');
    expect(printed).toContain('noodle github runs');
  });

  it('emits status JSON without token material', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['status', '--org', 'acme', '--app', 'hello', '--json'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).not.toContain('admin-token');
    const body = JSON.parse(printed) as {
      ok: true;
      data: { target: { org: string; app: string; env: string } };
    };
    expect(body.ok).toBe(true);
    expect(body.data.target).toEqual({ org: 'acme', app: 'hello', env: 'prod' });
  });

  it('--watch combined with --json is a usage error, not a silent pick of one', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['status', '--org', 'acme', '--app', 'hello', '--watch', '--json'], {}, home),
    ).toBe(2);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).error.code).toBe(
      'watch_json_conflict',
    );
  });

  it('statusFrame (the fetch+render --watch polls) renders the same content the one-shot print does', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    const statusUrl = `${service.url}/v1/orgs/acme/apps/hello/envs/prod/status`;
    const result = await statusFrame(statusUrl, { serviceUrl: service.url, token: 'admin-token' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The watch frame reuses the same detail-card string the one-shot print emits.
      expect(result.frame.split('\n')[0]).toBe('acme/hello/prod');
      expect(result.frame).toMatch(/health\s+ready/);
      expect(result.frame).toContain('NEXT');
    }
  });

  it('statusFrame resolves a CliFailure (not a throw) when the fetch fails', async () => {
    const result = await statusFrame(
      'http://127.0.0.1:1/v1/orgs/acme/apps/hello/envs/prod/status',
      {
        serviceUrl: 'http://127.0.0.1:1',
        token: 'admin-token',
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBeDefined();
  });

  it('updates hosted access through the service API', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(
      await run(['access', 'set', 'org-members', '--org', 'acme', '--app', 'hello'], {}, home),
    ).toBe(0);
    expect(stdout()).toContain('access:  org-members');
    logSpy.mockClear();
    expect(await run(['status', '--org', 'acme', '--app', 'hello', '--json'], {}, home)).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])).data.deployment.accessMode).toBe(
      'org-members',
    );
  });

  it('rolls back a hosted deployment and returns JSON metadata', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(
        [
          'deploy',
          HELLO,
          '--org',
          'acme',
          '--app',
          'hello',
          '--version',
          '1',
          '--owner-subject',
          'oauth-owner-1',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const firstDeploymentId = /deploymentId:\s+(\S+)/.exec(stdout())?.[1];
    expect(firstDeploymentId).toBeDefined();
    logSpy.mockClear();

    expect(
      await run(
        [
          'deploy',
          HELLO,
          '--org',
          'acme',
          '--app',
          'hello',
          '--version',
          '1',
          '--owner-subject',
          'oauth-owner-2',
        ],
        {},
        home,
      ),
    ).toBe(0);
    const secondDeploymentId = /deploymentId:\s+(\S+)/.exec(stdout())?.[1];
    expect(secondDeploymentId).toBeDefined();
    expect(secondDeploymentId).not.toBe(firstDeploymentId);
    logSpy.mockClear();

    expect(
      await run(
        ['rollback', firstDeploymentId as string, '--org', 'acme', '--app', 'hello', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: true;
      data: {
        rollback: {
          deploymentId: string;
          previousDeploymentId: string;
          alreadyActive: boolean;
          ownerSubject?: string;
        };
      };
    };
    expect(body.data.rollback).toMatchObject({
      deploymentId: firstDeploymentId,
      previousDeploymentId: secondDeploymentId,
      alreadyActive: false,
      ownerSubject: 'oauth-owner-1',
    });
    logSpy.mockClear();
    expect(
      await run(
        ['rollback', firstDeploymentId as string, '--org', 'acme', '--app', 'hello'],
        {},
        home,
      ),
    ).toBe(0);
    expect(stdout()).toMatch(/owner:\s+oauth-owner-1/);
  });

  it('rejects unknown rollback flags before treating values as deployment ids', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(await run(['rollback', '--bogus', 'dep-abc', '--json'], {}, home)).toBe(2);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('usage_error');
    expect(body.error.message).toContain('unknown rollback option --bogus');
  });

  it('returns auth exit code and JSON diagnostics when hosted operations lack a token', async () => {
    writeConfig({ serviceUrl: service.url, defaultOrg: 'acme' }, home);
    expect(await run(['status', '--org', 'acme', '--app', 'hello', '--json'], {}, home)).toBe(3);
    const body = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
      ok: false;
      error: { code: string; next: string };
    };
    expect(body.error.code).toBe('auth_required');
    expect(body.error.next).toBe('noodle login');
  });
});

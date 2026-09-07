import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryUserAppLogStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * `noodle logs` filter flags (Stage D): --level/--search/--since/--until pass through to the tenant
 * logs route (service + CLI in the same slice). Real service, seeded store — the logs-ops pattern.
 */
let service: RunningService;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  const logs = new InMemoryUserAppLogStore();
  await logs.emit({
    level: 'info',
    message: 'runtime ready',
    org: 'acme',
    app: 'hello',
    env: 'prod',
  });
  await logs.emit({
    level: 'error',
    message: 'connector boom: upstream 500',
    org: 'acme',
    app: 'hello',
    env: 'prod',
  });
  await logs.emit({
    level: 'warn',
    message: 'OPENAI_API_KEY missing',
    org: 'acme',
    app: 'hello',
    env: 'prod',
  });

  service = await serveService({
    port: 0,
    userAppLogStore: logs,
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
  home = mkdtempSync(join(tmpdir(), 'noodle-logs-filters-'));
  chdirIsolated(home);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
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

describe('noodle logs filters', () => {
  it('--level narrows to matching records', async () => {
    const code = await run(
      ['logs', '--org', 'acme', '--app', 'hello', '--level', 'error', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as { data: { events: readonly { level: string }[] } };
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]?.level).toBe('error');
  });

  it('--search matches case-insensitively as plain text', async () => {
    const code = await run(
      ['logs', '--org', 'acme', '--app', 'hello', '--search', 'BOOM', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as { data: { events: readonly { message: string }[] } };
    expect(body.data.events).toHaveLength(1);
    expect(body.data.events[0]?.message).toContain('connector boom');
  });

  it('--since excludes older records', async () => {
    const code = await run(
      ['logs', '--org', 'acme', '--app', 'hello', '--since', '2099-01-01T00:00:00Z', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as { data: { events: readonly unknown[] } };
    expect(body.data.events).toHaveLength(0);
  });

  it('an invalid --level surfaces the service 400 as a failure', async () => {
    const code = await run(
      ['logs', '--org', 'acme', '--app', 'hello', '--level', 'verbose', '--json'],
      {},
      home,
    );
    expect(code).not.toBe(0);
  });
});

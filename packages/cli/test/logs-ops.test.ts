import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryControlPlaneStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_HOSTED_OBSERVABILITY } from '../src/commands/catalog-data-hosted-observability.js';
import { runLogs } from '../src/commands/logs-ops.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

const HELLO = join(import.meta.dirname, '..', '..', '..', 'examples', 'hello', 'src', 'server.ts');
const logsCommand = CATALOG_HOSTED_OBSERVABILITY.find((command) => command.name === 'logs');
const followFlag = logsCommand?.flags?.find((flag) => flag.name === 'follow');
if (followFlag === undefined) throw new Error('logs --follow catalog metadata is missing');
const FOLLOW_FLAGS = [followFlag.name, ...followFlag.aliases].map((name) => `--${name}`);

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
  home = mkdtempSync(join(tmpdir(), 'noodle-logs-cli-'));
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

describe('noodle logs', () => {
  it('reads the tenant deploy-lifecycle log as JSON without leaking material', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['logs', '--org', 'acme', '--app', 'hello', '--json'], {}, home)).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: {
        service: string;
        events: Array<{ level: string; message: string }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.service).toBe(service.url);
    expect(
      body.data.events.some((e) => e.level === 'info' && e.message.includes('deployment')),
    ).toBe(true);
    // The token is never echoed back into CLI output.
    expect(stdout()).not.toContain('admin-token');
  });

  it('prints a human-readable line for the deploy lifecycle log', async () => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    expect(await run(['logs', '--org', 'acme', '--app', 'hello'], {}, home)).toBe(0);
    const printed = stdout();
    expect(printed).toContain('INFO');
    expect(printed).toContain('hello/prod');
    expect(printed).toContain('deployment live');
  });

  it.each(
    FOLLOW_FLAGS,
  )('switches to typed NDJSON envelopes for the catalog spelling %s', async (followFlag) => {
    writeConfig({ serviceUrl: service.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    expect(
      await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '1'], {}, home),
    ).toBe(0);
    logSpy.mockClear();

    const code = await runLogs(
      ['--org', 'acme', '--app', 'hello', '--json', followFlag, '--max-polls', '1'],
      {},
      home,
      async () => {
        await run(['deploy', HELLO, '--org', 'acme', '--app', 'hello', '--version', '2'], {}, home);
      },
    );

    expect(code).toBe(0);
    const envelopes = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => assertJsonEnvelope(JSON.parse(line)));
    expect(envelopes[0]).toMatchObject({
      ok: true,
      data: { kind: 'snapshot', snapshot: { events: expect.any(Array) } },
    });
    expect(envelopes.slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ok: true,
          data: { kind: 'event', event: expect.objectContaining({ message: 'deployment live' }) },
        }),
      ]),
    );
  });
});

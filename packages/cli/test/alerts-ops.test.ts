import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryAlertRuleStore, type RunningService, serveService } from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

/**
 * End-to-end CLI tests for `noodle alerts add|list|remove|test` (analytics alerting E2): a real
 * service is booted with an in-memory alert-rule store; the CLI drives the tenant alert routes.
 * Mirrors `analytics-ops.test.ts`. The webhook URL is sensitive: after `add`, no output may ever
 * contain it again (the service redacts to origin), and `--json` follows the ADR 0129 envelope.
 */

const SECRET = 'secret-cli-webhook-token';
let service: RunningService;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let hookServer: Server;
let hookPort: number;
let hookBodies: string[] = [];

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      hookBodies.push(Buffer.concat(chunks).toString('utf8'));
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
  hookPort = (hookServer.address() as AddressInfo).port;

  service = await serveService({
    port: 0,
    alertRuleStore: new InMemoryAlertRuleStore(),
    alertWebhookAllowLoopback: true,
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
  await new Promise<void>((resolve) => {
    hookServer.close(() => resolve());
    hookServer.closeAllConnections?.();
  });
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-alerts-cli-'));
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

function stderr(): string {
  return errSpy.mock.calls.map((call) => String(call[0])).join('\n');
}

async function addRule(extra: readonly string[] = []): Promise<string> {
  const code = await run(
    [
      'alerts',
      'add',
      '--org',
      'acme',
      '--app',
      'support',
      '--metric',
      'error_share',
      '--threshold',
      '0.2',
      '--window',
      '15',
      '--webhook',
      `https://hooks.example.com/T0/${SECRET}`,
      '--name',
      'error spike',
      '--json',
      ...extra,
    ],
    {},
    home,
  );
  expect(code).toBe(0);
  const body = JSON.parse(stdout()) as { ok: boolean; data: { id: string } };
  expect(body.ok).toBe(true);
  logSpy.mockClear();
  return body.data.id;
}

describe('noodle alerts add', () => {
  it('creates a rule and never echoes the webhook URL back', async () => {
    const code = await run(
      [
        'alerts',
        'add',
        '--org',
        'acme',
        '--app',
        'support',
        '--metric',
        'p95_ms',
        '--threshold',
        '750',
        '--window',
        '60',
        '--webhook',
        `https://hooks.example.com/T0/${SECRET}`,
        '--cooldown',
        '30',
        '--json',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: {
        id: string;
        metric: string;
        threshold: number;
        windowMinutes: number;
        cooldownMinutes: number;
        webhook: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.metric).toBe('p95_ms');
    expect(body.data.threshold).toBe(750);
    expect(body.data.windowMinutes).toBe(60);
    expect(body.data.cooldownMinutes).toBe(30);
    expect(stdout()).not.toContain(SECRET);
    await run(['alerts', 'remove', body.data.id, '--org', 'acme', '--app', 'support'], {}, home);
  });

  it('rejects a bad metric with usage exit code 2 before calling the service', async () => {
    const code = await run(
      [
        'alerts',
        'add',
        '--org',
        'acme',
        '--app',
        'support',
        '--metric',
        'latency',
        '--threshold',
        '1',
        '--window',
        '15',
        '--webhook',
        'https://hooks.example.com/x',
        '--json',
      ],
      {},
      home,
    );
    expect(code).toBe(2);
  });

  it('requires --webhook', async () => {
    const code = await run(
      [
        'alerts',
        'add',
        '--org',
        'acme',
        '--app',
        'support',
        '--metric',
        'calls',
        '--threshold',
        '100',
        '--window',
        '5',
      ],
      {},
      home,
    );
    expect(code).toBe(2);
  });

  it('fails cleanly without auth', async () => {
    writeConfig({ serviceUrl: service.url, defaultOrg: 'acme' }, home);
    const code = await run(
      [
        'alerts',
        'add',
        '--org',
        'acme',
        '--app',
        'support',
        '--metric',
        'calls',
        '--threshold',
        '100',
        '--window',
        '5',
        '--webhook',
        'https://hooks.example.com/x',
        '--json',
      ],
      {},
      home,
    );
    expect(code).not.toBe(0);
  });
});

describe('noodle alerts list', () => {
  it('lists rules as the ADR 0129 JSON envelope without the webhook URL', async () => {
    const id = await addRule();
    const code = await run(
      ['alerts', 'list', '--org', 'acme', '--app', 'support', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { rules: readonly { id: string; metric: string; webhook: string }[] };
    };
    expect(body.ok).toBe(true);
    expect(body.data.rules.map((r) => r.id)).toContain(id);
    expect(stdout()).not.toContain(SECRET);
    logSpy.mockClear();
    await run(['alerts', 'remove', id, '--org', 'acme', '--app', 'support'], {}, home);
  });

  it('renders a plain table with the redacted webhook', async () => {
    const id = await addRule();
    const code = await run(['alerts', 'list', '--org', 'acme', '--app', 'support'], {}, home);
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('error_share');
    expect(text).toContain('hooks.example.com');
    expect(text).not.toContain(SECRET);
    logSpy.mockClear();
    await run(['alerts', 'remove', id, '--org', 'acme', '--app', 'support'], {}, home);
  });

  it('prints an empty-state line when no rules exist', async () => {
    const code = await run(['alerts', 'list', '--org', 'acme', '--app', 'support'], {}, home);
    expect(code).toBe(0);
    expect(stdout().toLowerCase()).toContain('no alert rules');
  });

  it('emits the distilled agent summary under --agent-output', async () => {
    const id = await addRule();
    const code = await run(
      ['alerts', 'list', '--org', 'acme', '--app', 'support', '--agent-output'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      health: string;
      rules: number;
      breaching: readonly unknown[];
    };
    expect(body.ok).toBe(true);
    expect(body.health).toBe('ok');
    expect(body.rules).toBe(1);
    expect(body.breaching).toEqual([]);
    expect(stdout()).not.toContain(SECRET);
    logSpy.mockClear();
    await run(['alerts', 'remove', id, '--org', 'acme', '--app', 'support'], {}, home);
  });
});

describe('noodle alerts test / remove', () => {
  it('test-fires the webhook through the service and reports delivery', async () => {
    hookBodies = [];
    const code = await run(
      [
        'alerts',
        'add',
        '--org',
        'acme',
        '--app',
        'support',
        '--metric',
        'error_count',
        '--threshold',
        '5',
        '--window',
        '5',
        '--webhook',
        `http://127.0.0.1:${hookPort}/hook/${SECRET}`,
        '--json',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
    const created = JSON.parse(stdout()) as { data: { id: string } };
    logSpy.mockClear();

    const testCode = await run(
      ['alerts', 'test', created.data.id, '--org', 'acme', '--app', 'support', '--json'],
      {},
      home,
    );
    expect(testCode).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      data: { delivery: { delivered: boolean; status?: number } };
    };
    expect(body.data.delivery.delivered).toBe(true);
    expect(hookBodies).toHaveLength(1);
    expect((JSON.parse(hookBodies[0] ?? '{}') as { event: string }).event).toBe('test');
    expect(stdout()).not.toContain(SECRET);
    logSpy.mockClear();

    const removeCode = await run(
      ['alerts', 'remove', created.data.id, '--org', 'acme', '--app', 'support', '--json'],
      {},
      home,
    );
    expect(removeCode).toBe(0);
    logSpy.mockClear();

    const listCode = await run(
      ['alerts', 'list', '--org', 'acme', '--app', 'support', '--json'],
      {},
      home,
    );
    expect(listCode).toBe(0);
    const list = JSON.parse(stdout()) as { data: { rules: readonly unknown[] } };
    expect(list.data.rules).toEqual([]);
  });

  it('requires a rule id for remove and test', async () => {
    for (const sub of ['remove', 'test']) {
      const code = await run(['alerts', sub, '--org', 'acme', '--app', 'support'], {}, home);
      expect(code).toBe(2);
    }
  });

  it('rejects an unknown subcommand with usage', async () => {
    const code = await run(['alerts', 'bogus'], {}, home);
    expect(code).toBe(2);
    expect(`${stdout()}\n${stderr()}`.length).toBeGreaterThan(0);
  });
});

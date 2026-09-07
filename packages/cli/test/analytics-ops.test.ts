import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InMemoryControlPlaneStore,
  InMemoryRequestEventStore,
  type RunningService,
  serveService,
} from '@noodle-borg/service';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvents } from '../src/commands/analytics-ops.js';
import { CATALOG_HOSTED_OBSERVABILITY } from '../src/commands/catalog-data-hosted-observability.js';
import { run, writeConfig } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';
import { assertJsonEnvelope } from './helpers/json-envelope.js';

const eventsCommand = CATALOG_HOSTED_OBSERVABILITY.find((command) => command.name === 'events');
const tailFlag = eventsCommand?.flags?.find((flag) => flag.name === 'tail');
if (tailFlag === undefined) throw new Error('events --tail catalog metadata is missing');
const TAIL_FLAGS = [tailFlag.name, ...tailFlag.aliases].map((name) => `--${name}`);

/**
 * End-to-end CLI tests for `noodle metrics` and `noodle events` (ADR 0121 Stage B): a real service is
 * booted with a seeded analytics store; the CLI reads through the tenant routes. Mirrors
 * `logs-ops.test.ts`.
 */
let service: RunningService;
let home: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

let seededEvents: InMemoryRequestEventStore;

beforeAll(async () => {
  const events = new InMemoryRequestEventStore();
  seededEvents = events;
  const base = {
    org: 'acme',
    app: 'support',
    env: 'happy-hour',
    sessionSource: 'none',
    subjectKind: 'anonymous',
    kind: 'usage',
    durationMs: 40,
  } as const;
  await events.emit({
    ...base,
    requestId: 'r-init',
    sessionId: 's-1',
    method: 'initialize',
    clientName: 'claude-ai',
    clientFamily: 'claude-ai',
    protocolEra: 'legacy',
    outcome: 'ok',
  });
  await events.emit({
    ...base,
    requestId: 'r-1',
    sessionId: 's-1',
    method: 'tools/call',
    toolName: 'search_orders',
    clientFamily: 'claude-ai',
    protocolEra: 'legacy',
    outcome: 'ok',
    outputTokensEst: 80,
  });
  await events.emit({
    ...base,
    requestId: 'r-2',
    method: 'tools/call',
    toolName: 'refund_order',
    clientFamily: 'openai-mcp',
    protocolEra: 'modern',
    outcome: 'tool_error',
    errorKind: 'connector_error',
    durationMs: 140,
  });

  const controlPlaneStore = new InMemoryControlPlaneStore();
  await controlPlaneStore.createOrg({ slug: 'acme' });
  service = await serveService({
    port: 0,
    requestEventStore: events,
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
  const headers = {
    authorization: 'Bearer admin-token',
    'content-type': 'application/json',
  };
  const manifest = `
manifestVersion: "1"
server:
  name: support
  version: 1.0.0
  title: Support
tools:
  - name: ping
    description: Ping.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            ok: true
      output:
        ok: \${steps.build.ok}
`;
  for (const environment of ['prod', 'happy-hour']) {
    const deployed = await fetch(
      `${service.url}/v1/orgs/acme/apps/support/envs/${environment}/deploy`,
      { method: 'POST', headers, body: JSON.stringify({ manifest, serverVersion: '1' }) },
    );
    expect(deployed.status).toBe(201);
  }
  const designated = await fetch(
    `${service.url}/v1/orgs/acme/apps/support/production-environment`,
    { method: 'PUT', headers, body: JSON.stringify({ environment: 'happy-hour' }) },
  );
  expect(designated.status).toBe(200);
  await events.emit({
    ...base,
    env: 'prod',
    requestId: 'prod-noise',
    method: 'tools/call',
    toolName: 'production_noise',
    outcome: 'ok',
  });
});

afterAll(async () => {
  await service.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-analytics-cli-'));
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

describe('noodle metrics', () => {
  it('returns the aggregated metrics in a data-wrapped envelope without leaking the token', async () => {
    const code = await run(['metrics', '--org', 'acme', '--app', 'support', '--json'], {}, home);
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{
      service: string;
      metrics: {
        totals: { requests: number; sessions: number; legacyInitializations: number };
        errors: { toolErrors: number; mcpErrors: number };
        latency: { p95Ms: number };
        byTool: readonly { tool: string; calls: number }[];
      };
    }>(JSON.parse(stdout()));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success envelope');
    const { data } = envelope;
    expect(data.service).toBe(service.url);
    expect(data.metrics.totals.requests).toBe(2);
    expect(data.metrics.totals.sessions).toBe(1);
    expect(data.metrics.totals.legacyInitializations).toBe(1);
    expect(data.metrics.errors.toolErrors).toBe(1);
    expect(data.metrics.byTool.map((t) => t.tool)).toContain('refund_order');
    expect(stdout()).not.toContain('admin-token');
  });

  it('renders a human summary on a plain stream', async () => {
    const code = await run(['metrics', '--org', 'acme', '--app', 'support'], {}, home);
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('requests');
    expect(text).toContain('tool calls');
    expect(text).not.toContain('sessions');
    expect(text).toContain('refund_order');
  });

  it('uses the designated production environment by default and lets explicit --env win', async () => {
    expect(await run(['metrics', '--org', 'acme', '--app', 'support', '--json'], {}, home)).toBe(0);
    const production = JSON.parse(stdout());
    expect(production.data.metrics.totals.requests).toBe(2);
    logSpy.mockClear();

    expect(
      await run(
        ['metrics', '--org', 'acme', '--app', 'support', '--env', 'prod', '--json'],
        {},
        home,
      ),
    ).toBe(0);
    expect(JSON.parse(stdout()).data.metrics.totals.requests).toBe(1);
  });

  it('requires an explicit choice for unresolved apps in both analytics commands', async () => {
    const realFetch = globalThis.fetch.bind(globalThis);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (String(input).endsWith('/v1/orgs/acme/apps/ambiguous/envs')) {
        return Promise.resolve(
          Response.json({
            ok: true,
            data: {
              orgSlug: 'acme',
              appSlug: 'ambiguous',
              envs: [
                { envName: 'happy-hour', isProduction: false },
                { envName: 'preview', isProduction: false },
              ],
            },
          }),
        );
      }
      return realFetch(input, init);
    });

    try {
      for (const command of ['metrics', 'events']) {
        errSpy.mockClear();
        expect(
          await run([command, '--org', 'acme', '--app', 'ambiguous', '--json'], {}, home),
        ).toBe(2);
        const failure = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as {
          error: { code: string };
        };
        expect(failure.error.code).toBe('production_environment_required');
        expect(errSpy).not.toHaveBeenCalled();

        expect(
          await run(
            [command, '--org', 'acme', '--app', 'ambiguous', '--env', 'happy-hour', '--json'],
            {},
            home,
          ),
        ).toBe(0);
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('emits the distilled agent summary under --agent-output', async () => {
    const code = await run(
      ['metrics', '--org', 'acme', '--app', 'support', '--agent-output'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as {
      ok: boolean;
      health: string;
      summary: string;
      attention: readonly { tool: string; action: string }[];
      key: {
        requests: number;
        toolCalls: number;
        legacyInitializations: number;
        p95Ms: number;
        errorRate: number;
      };
    };
    expect(body.ok).toBe(true);
    // Seeded refund_order has 1 errored call of 1 — below the min-calls bar, so no attention item.
    expect(body.health).toBe('ok');
    expect(body.attention).toEqual([]);
    expect(body.summary).toContain('requests');
    expect(body.summary).toContain('2 tool calls');
    expect(body.summary).not.toContain('sessions');
    expect(body.key).toMatchObject({
      requests: 2,
      toolCalls: 2,
      legacyInitializations: 1,
    });
    expect(body.key).not.toHaveProperty('sessions');
    expect(body.key.p95Ms).toBeGreaterThan(0);
  });

  // Back-compat: `--fix-prompt` stays an accepted alias for metrics' canonical `--agent-output`
  // (S4 keeps both spellings parsed even though only `--agent-output` is advertised).
  it('accepts --fix-prompt as an alias for --agent-output (same distilled summary)', async () => {
    const code = await run(
      ['metrics', '--org', 'acme', '--app', 'support', '--fix-prompt'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as { ok: boolean; health: string; summary: string };
    expect(body.ok).toBe(true);
    expect(body.health).toBe('ok');
    expect(body.summary).toContain('requests');
  });

  it('rejects prototype-chain window names with exit 2', async () => {
    for (const window of ['toString', '__proto__']) {
      logSpy.mockClear();
      const code = await run(
        ['metrics', '--org', 'acme', '--app', 'support', '--window', window, '--json'],
        {},
        home,
      );
      expect(code).toBe(2);
    }
  });

  it('fails cleanly without auth', async () => {
    writeConfig({ serviceUrl: service.url, defaultOrg: 'acme' }, home);
    logSpy.mockClear();
    const code = await run(['metrics', '--org', 'acme', '--app', 'support', '--json'], {}, home);
    expect(code).not.toBe(0);
  });
});

describe('noodle events', () => {
  it('lists events as JSON with filters applied', async () => {
    const code = await run(
      ['events', '--org', 'acme', '--app', 'support', '--status', 'tool_error', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{ events: readonly { requestId: string }[] }>(
      JSON.parse(stdout()),
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success envelope');
    expect(envelope.data.events.map((e) => e.requestId)).toEqual(['r-2']);
  });

  it('reconstructs a session with --session', async () => {
    const code = await run(
      ['events', '--org', 'acme', '--app', 'support', '--session', 's-1', '--json'],
      {},
      home,
    );
    expect(code).toBe(0);
    const envelope = assertJsonEnvelope<{ events: readonly { requestId: string }[] }>(
      JSON.parse(stdout()),
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) throw new Error('expected success envelope');
    expect(envelope.data.events.map((e) => e.requestId)).toEqual(['r-init', 'r-1']);
  });

  it('renders rows on a plain stream', async () => {
    const code = await run(['events', '--org', 'acme', '--app', 'support'], {}, home);
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('tools/call');
    expect(text).toContain('search_orders');
  });
});

// Isolated in its own env (`attn`) so the seeded attention data cannot leak into the other
// suites' reads regardless of execution order.
describe('noodle metrics --agent-output attention', () => {
  it('flags attention tools with a suggested action', async () => {
    const seed = {
      org: 'acme',
      app: 'support',
      env: 'attn',
      sessionSource: 'none',
      subjectKind: 'anonymous',
      kind: 'usage',
      method: 'tools/call',
      toolName: 'refund_order',
      durationMs: 90,
    } as const;
    for (let i = 0; i < 4; i++) {
      await seededEvents.emit({ ...seed, requestId: `extra-ok-${i}`, outcome: 'ok' });
    }
    for (let i = 0; i < 2; i++) {
      await seededEvents.emit({
        ...seed,
        requestId: `extra-err-${i}`,
        outcome: 'tool_error',
        errorKind: 'connector_error',
      });
    }
    const code = await run(
      ['metrics', '--org', 'acme', '--app', 'support', '--env', 'attn', '--agent-output'],
      {},
      home,
    );
    expect(code).toBe(0);
    const body = JSON.parse(stdout()) as {
      health: string;
      attention: readonly { tool: string; action: string }[];
    };
    expect(body.health).toBe('attention');
    expect(body.attention[0]?.tool).toBe('refund_order');
    expect(body.attention[0]?.action).toContain('noodle events --tool refund_order');
  });
});

describe('noodle events --tail', () => {
  const gate = {
    authorize: (req: { headers: Record<string, string | undefined> }) => {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (token !== 'admin-token')
        return Promise.resolve({
          ok: false as const,
          status: 401,
          message: 'missing bearer token',
        });
      return Promise.resolve({
        ok: true as const,
        identity: { subject: 'admin-sub', email: 'admin@noodleseed.com', superAdmin: true },
      });
    },
  };

  it.each(
    TAIL_FLAGS,
  )('emits typed NDJSON envelopes for the catalog spelling %s', async (tailFlag) => {
    const suffix = tailFlag.slice(2);
    const base = {
      org: 'acme',
      app: 'support',
      env: `tailjson-${suffix}`,
      sessionSource: 'none',
      subjectKind: 'anonymous',
      kind: 'usage',
      durationMs: 10,
      method: 'tools/call',
      toolName: 'ping',
      outcome: 'ok',
    } as const;
    await seededEvents.emit({ ...base, requestId: `${suffix}-seed` });
    logSpy.mockClear();
    // Inject the poll sleep so a fresh event is guaranteed to land *after* the initial fetch — the
    // single poll then streams exactly that new event, deterministically.
    const sleep = vi.fn(async () => {
      await seededEvents.emit({ ...base, requestId: `${suffix}-fresh` });
    });
    const code = await runEvents(
      // prettier-ignore
      [
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        `tailjson-${suffix}`,
        '--json',
        tailFlag,
        '--max-polls',
        '1',
      ],
      {},
      home,
      sleep,
    );
    expect(code).toBe(0);
    const jsonLines = logSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.trim().startsWith('{'));
    const envelopes = jsonLines.map((line) => assertJsonEnvelope(JSON.parse(line)));
    expect(envelopes).toHaveLength(2);
    expect(envelopes[0]).toMatchObject({
      ok: true,
      data: {
        kind: 'snapshot',
        snapshot: { events: [{ requestId: `${suffix}-seed` }] },
      },
    });
    expect(envelopes[1]).toMatchObject({
      ok: true,
      data: { kind: 'event', event: { requestId: `${suffix}-fresh` } },
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('honors --max-polls and exits cleanly after the bounded polls', async () => {
    const code = await run(
      // prettier-ignore
      [
        'events',
        '--org',
        'acme',
        '--app',
        'support',
        '--json',
        '--tail',
        '--interval',
        '0.5',
        '--max-polls',
        '1',
      ],
      {},
      home,
    );
    expect(code).toBe(0);
  });

  it('rejects a malformed --max-polls with exit 2 instead of silently unbounding the tail', async () => {
    const code = await run(
      ['events', '--org', 'acme', '--app', 'support', '--json', '--tail', '--max-polls', 'abc'],
      {},
      home,
    );
    expect(code).toBe(2);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      error: { code: 'invalid_max_polls' },
    });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('emits a terminal failure envelope to stdout after repeated poll failures', async () => {
    const store = new InMemoryRequestEventStore();
    await store.emit({
      org: 'acme',
      app: 'support',
      env: 'prod',
      sessionSource: 'none',
      subjectKind: 'anonymous',
      kind: 'usage',
      durationMs: 5,
      requestId: 'seed-1',
      method: 'tools/call',
      toolName: 'ping',
      outcome: 'ok',
    });
    const flaky = await serveService({
      port: 0,
      requestEventStore: store,
      deployGate: gate,
      verifyOwnerToken: () => Promise.resolve(null),
      authServerIssuer: 'https://as.noodle.test',
    });
    writeConfig({ serviceUrl: flaky.url, authToken: 'admin-token', defaultOrg: 'acme' }, home);
    const tail = run(
      [
        'events',
        '--org',
        'acme',
        '--app',
        'support',
        '--env',
        'prod',
        '--json',
        '--tail',
        '--interval',
        '0.5',
      ],
      {},
      home,
    );
    // Let the initial (successful) fetch land, then kill the service so every poll fails.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flaky.close();
    const code = await tail;
    expect(code).toBe(1);
    const lines = logSpy.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(lines.at(-1)).toMatchObject({
      ok: false,
      error: { code: 'service_unreachable', retryable: true },
    });
    expect(errSpy).not.toHaveBeenCalled();
  }, 20000);
});

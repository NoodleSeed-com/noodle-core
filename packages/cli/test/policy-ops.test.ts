import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderPoliciesTable, runPolicy } from '../src/commands/policy-ops.js';
import { writeConfig } from '../src/config.js';

const homes: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'noodle-policy-cli-'));
  homes.push(home);
  writeConfig({ serviceUrl: 'https://svc.example', authToken: 'TOKEN' }, home);
  return home;
}

const HOUR_MS = 3_600_000;

/** Three assignments covering the derived STATE values: suspended, denied, active. */
const LIST_POLICIES = [
  {
    id: 'org:acme:suspend',
    version: 2,
    scope: { level: 'org', org: 'acme' },
    policy: { schemaVersion: 1, suspended: true },
    createdAt: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
  },
  {
    id: 'app:acme:support:execute-deny',
    version: 1,
    scope: { level: 'app', org: 'acme', app: 'support' },
    policy: { schemaVersion: 1, categories: { execute: { effect: 'deny' } } },
    createdAt: new Date(Date.now() - 3 * 24 * HOUR_MS).toISOString(),
  },
  {
    id: 'org:acme:execute-quota',
    version: 1,
    scope: { level: 'org', org: 'acme' },
    policy: {
      schemaVersion: 1,
      categories: { execute: { quota: { limit: 10, windowSeconds: 60 } } },
    },
    createdAt: new Date().toISOString(),
  },
];

describe('noodle policy list', () => {
  it('renders the branded policies table with derived state and keeps the count line', async () => {
    const home = tempHome();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, policies: LIST_POLICIES })),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPolicy(['list', '--org', 'acme'], {}, home)).resolves.toBe(0);
    const out = log.mock.calls.map((call) => String(call[0])).join('\n');
    for (const header of ['POLICY', 'SCOPE', 'STATE', 'UPDATED']) expect(out).toContain(header);
    expect(out).toContain('org:acme:suspend');
    expect(out).toContain('suspended');
    expect(out).toContain('denied');
    expect(out).toContain('active');
    expect(out).toContain('2h ago');
    expect(out).toContain('3 policy assignment(s).');
  });

  it('wraps --json payloads and skips the table when empty', async () => {
    const home = tempHome();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, policies: LIST_POLICIES })),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPolicy(['list', '--org', 'acme', '--json'], {}, home)).resolves.toBe(0);
    const body = JSON.parse(log.mock.calls[0]?.[0] as string);
    expect(Object.keys(body).sort()).toEqual(['data', 'ok']);
    expect(body.data.policies).toEqual(LIST_POLICIES);

    log.mockClear();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, policies: [] })),
    );
    await expect(runPolicy(['list', '--org', 'acme'], {}, home)).resolves.toBe(0);
    const out = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(out).not.toContain('POLICY');
    expect(out).toContain('0 policy assignment(s).');
  });

  it('maps states to the semantic palette under truecolor', () => {
    const colored = renderPoliciesTable(LIST_POLICIES, { color: 'truecolor', glyph: 'unicode' });
    expect(colored).toContain('38;2;34;197;94'); // active → green
    expect(colored).toContain('38;2;245;158;11'); // suspended → amber
    expect(colored).toContain('38;2;244;63;94'); // denied → rose
  });
});

describe('noodle policy', () => {
  it('reports policy capability status', async () => {
    const home = tempHome();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, capabilities: ['controls'] })),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPolicy(['status', '--json'], {}, home)).resolves.toBe(0);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      ok: true,
      data: { service: 'https://svc.example', enabled: true },
    });
  });

  it('builds deterministic guided deny assignments as API payloads', async () => {
    const home = tempHome();
    let requestBody: unknown;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(init?.body?.toString() ?? '{}') as unknown;
        return Response.json({
          ok: true,
          policy: { id: 'operation:acme:support:prod:delete_case:execute-deny' },
        });
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runPolicy(
        [
          'deny',
          'execute',
          '--org',
          'acme',
          '--app',
          'support',
          '--env',
          'prod',
          '--operation',
          'delete_case',
          '--reason',
          'disabled_for_review',
        ],
        {},
        home,
      ),
    ).resolves.toBe(0);

    expect(requestBody).toMatchObject({
      id: 'operation:acme:support:prod:delete_case:execute-deny',
      reason: 'disabled_for_review',
      source: 'cli',
      scope: {
        level: 'operation',
        org: 'acme',
        app: 'support',
        env: 'prod',
        name: 'delete_case',
      },
      policy: {
        schemaVersion: 1,
        categories: { execute: { effect: 'deny', reason: 'disabled_for_review' } },
      },
    });
  });

  it('forwards optimistic idempotency controls for policy deletion', async () => {
    const home = tempHome();
    let request: { url: string; method?: string; body?: unknown } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        request = {
          url: input.toString(),
          method: init?.method,
          body: JSON.parse(init?.body?.toString() ?? '{}') as unknown,
        };
        return Response.json({
          ok: true,
          policy: { id: 'free-tier-default', version: 2, tombstone: true },
        });
      }),
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      runPolicy(
        [
          'delete',
          'free-tier-default',
          '--reason',
          'retire legacy quota',
          '--expected-version',
          '1',
          '--idempotency-key',
          'retire-free-tier-default-v1',
        ],
        {},
        home,
      ),
    ).resolves.toBe(0);

    expect(request).toEqual({
      url: 'https://svc.example/v1/policies/free-tier-default',
      method: 'DELETE',
      body: {
        reason: 'retire legacy quota',
        expectedVersion: 1,
        idempotencyKey: 'retire-free-tier-default-v1',
      },
    });
  });

  it('reads and updates commercial org plans through plan routes', async () => {
    const home = tempHome();
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? 'GET',
          ...(init?.body !== undefined
            ? { body: JSON.parse(init.body.toString()) as unknown }
            : {}),
        });
        return Response.json({
          ok: true,
          plan: {
            org: 'acme',
            plan: 'pro',
            state: 'active',
            source: 'policy',
            policyId: 'org:acme:commercial-plan',
            commercial: { provider: 'manual', externalRef: 'crm-123' },
          },
        });
      }),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPolicy(['plan', 'show', '--org', 'acme', '--json'], {}, home)).resolves.toBe(0);
    await expect(
      runPolicy(
        [
          'plan',
          'set',
          'pro',
          '--org',
          'acme',
          '--reason',
          'contract-started',
          '--external-ref',
          'crm-123',
          '--expected-version',
          '3',
          '--idempotency-key',
          'plan-pro-v4',
        ],
        {},
        home,
      ),
    ).resolves.toBe(0);
    await expect(
      runPolicy(
        [
          'plan',
          'suspend',
          '--org',
          'acme',
          '--reason',
          'nonpayment',
          '--external-ref',
          'invoice-456',
          '--expected-version',
          '4',
          '--idempotency-key',
          'plan-suspend-v5',
        ],
        {},
        home,
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      { url: 'https://svc.example/v1/orgs/acme/plan', method: 'GET' },
      {
        url: 'https://svc.example/v1/orgs/acme/plan',
        method: 'PUT',
        body: {
          plan: 'pro',
          reason: 'contract-started',
          source: 'cli',
          externalRef: 'crm-123',
          expectedVersion: 3,
          idempotencyKey: 'plan-pro-v4',
        },
      },
      {
        url: 'https://svc.example/v1/orgs/acme/plan/suspend',
        method: 'POST',
        body: {
          reason: 'nonpayment',
          source: 'cli',
          externalRef: 'invoice-456',
          expectedVersion: 4,
          idempotencyKey: 'plan-suspend-v5',
        },
      },
    ]);
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      ok: true,
      data: { plan: { org: 'acme', plan: 'pro' } },
    });
  });

  it('requires org and reason for plan writes', async () => {
    const home = tempHome();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runPolicy(['plan', 'show'], {}, home)).resolves.toBe(2);
    await expect(runPolicy(['plan', 'set', 'pro', '--org', 'acme'], {}, home)).resolves.toBe(2);
    await expect(runPolicy(['plan', 'suspend', '--org', 'acme'], {}, home)).resolves.toBe(2);
    await expect(
      runPolicy(
        ['plan', 'set', 'pro', '--org', 'acme', '--reason', 'contract', '--external-ref', '  '],
        {},
        home,
      ),
    ).resolves.toBe(2);
    await expect(
      runPolicy(
        ['plan', 'set', 'pro', '--org', 'acme', '--reason', 'contract', '--idempotency-key', '  '],
        {},
        home,
      ),
    ).resolves.toBe(2);
  });

  it.each([
    {
      label: 'a missing idempotency-key value',
      args: ['plan', 'set', 'pro', '--org', 'acme', '--reason', 'migration', '--idempotency-key'],
    },
    {
      label: 'a missing delete idempotency-key value',
      args: ['delete', 'free-tier-default', '--expected-version', '1', '--idempotency-key'],
    },
    {
      label: 'an external-ref that consumes the next flag',
      args: [
        'plan',
        'set',
        'pro',
        '--org',
        'acme',
        '--reason',
        'migration',
        '--external-ref',
        '--expected-version',
        '1',
      ],
    },
    {
      label: 'an idempotency-key that consumes the service flag',
      args: [
        'plan',
        'set',
        'pro',
        '--org',
        'acme',
        '--reason',
        'migration',
        '--expected-version',
        '1',
        '--idempotency-key',
        '--service',
        'https://intended.example',
      ],
    },
    {
      label: 'an unknown migration flag',
      args: [
        'plan',
        'set',
        'pro',
        '--org',
        'acme',
        '--reason',
        'migration',
        '--idempotency-keey',
        'migration-v1',
      ],
    },
  ])('rejects $label before sending a plan mutation', async ({ args }) => {
    const home = tempHome();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runPolicy(args, {}, home)).resolves.toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces legacy plan migration requirements in human output', async () => {
    const home = tempHome();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          plan: {
            org: 'acme',
            plan: 'pro',
            state: 'active',
            source: 'policy',
            policyId: 'org:acme:commercial-plan',
            policyVersion: 1,
            migrationRequired: true,
          },
        }),
      ),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(runPolicy(['plan', 'show', '--org', 'acme'], {}, home)).resolves.toBe(0);

    expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'migration: required',
    );
  });
});

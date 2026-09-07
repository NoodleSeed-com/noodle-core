import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig, writeProjectLink } from '../src/index.js';
import { chdirIsolated, restoreCwd } from './helpers/isolated-cwd.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(process.cwd(), 'contract', 'v1', name), 'utf8')) as {
    ok: true;
    data: Record<string, unknown>;
  };
const ACCOUNT_LIST = fixture('billing-accounts-list-response.json');
const ACCOUNT_DETAIL = fixture('billing-account-response.json');
const ORG_BILLING = fixture('org-billing-response.json');
const ACCOUNT_ID = (ACCOUNT_LIST.data.accounts as Array<{ id: string }>)[0]?.id ?? '';

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-read-'));
  chdirIsolated(home);
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN, defaultOrg: 'saved-org' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  restoreCwd();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}

function stub(body: unknown, status = 200) {
  const requests: Array<{ url: string; method: string; authorization: string | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
      });
      return Response.json(body, { status });
    }),
  );
  return requests;
}

describe('noodle billing accounts', () => {
  it('lists membership-scoped accounts with a stable JSON envelope', async () => {
    const requests = stub(ACCOUNT_LIST);

    expect(await run(['billing', 'accounts', 'list', '--json'], ENV, home)).toBe(0);
    expect(requests).toEqual([
      {
        url: `${SERVICE}/v1/billing-accounts`,
        method: 'GET',
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, accounts: ACCOUNT_LIST.data.accounts },
    });
    expect(stdout()).not.toContain(TOKEN);
    expect(stderr()).toBe('');
  });

  it('renders a concise human table and a successful empty state', async () => {
    stub(ACCOUNT_LIST);
    expect(await run(['billing', 'accounts', 'list'], ENV, home)).toBe(0);
    expect(stdout()).toContain('ACCOUNT ID');
    expect(stdout()).toContain(ACCOUNT_ID);
    expect(stdout()).toContain('free');
    expect(stdout()).toContain('owner');
    expect(stdout()).not.toContain(TOKEN);

    log.mockClear();
    vi.unstubAllGlobals();
    stub({ ok: true, data: { accounts: [] } });
    expect(await run(['billing', 'accounts', 'list'], ENV, home)).toBe(0);
    expect(stdout()).toBe('No billing accounts found for this identity.');
  });

  it('inspects a member account and makes unstarted operations explicit', async () => {
    const requests = stub(ACCOUNT_DETAIL);

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID, '--json'], ENV, home)).toBe(0);
    expect(requests[0]?.url).toBe(`${SERVICE}/v1/billing-accounts/${ACCOUNT_ID}`);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, ...ACCOUNT_DETAIL.data },
    });

    log.mockClear();
    vi.unstubAllGlobals();
    stub(ACCOUNT_DETAIL);
    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Not started');
    expect(output).toContain('Usage unavailable');
    expect(output).toContain('Legacy unchanged');
    expect(output).toContain('0 active / 1 limit');
    expect(output).toContain('pooled across linked organizations');
    expect(output).toContain('Pending activation');
    expect(output).toContain('90-day clock has not started');
    expect(output).toContain('acme');
    expect(output).not.toMatch(/\b0 used\b/i);
    expect(output).not.toContain(TOKEN);
  });

  it('labels account shadow usage as observational rather than a quota balance', async () => {
    const reporting = {
      ...ACCOUNT_DETAIL,
      data: {
        ...ACCOUNT_DETAIL.data,
        metering: {
          state: 'reporting',
          mode: 'shadow',
          observedCalls: 12_345,
          coverage: 'partial',
          observedSince: '2026-07-20T00:00:00.000Z',
          windowStart: '2026-07-15T00:00:00.000Z',
          windowEnd: '2026-08-15T00:00:00.000Z',
          remainingMcpCalls: null,
        },
        productionApps: { state: 'reporting', active: 3, limit: 5 },
      },
    };
    stub(reporting);

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('12,345 observed');
    expect(output).toContain('Shadow observation');
    expect(output).toContain('partial coverage');
    expect(output).toContain('not enforcement or a quota balance');
    expect(output).toContain('3 active / 5 limit');
    expect(output).not.toMatch(/remaining/i);
  });

  it('renders authoritative account usage and the pooled remaining balance', async () => {
    stub({
      ...ACCOUNT_DETAIL,
      data: {
        ...ACCOUNT_DETAIL.data,
        enforcement: { state: 'active', mode: 'authoritative' },
        metering: {
          state: 'reporting',
          mode: 'authoritative',
          coverage: 'complete',
          usedMcpCalls: 400,
          includedUsedMcpCalls: 400,
          overageUsedMcpCalls: 0,
          remainingMcpCalls: 999_600,
          countingSince: '2026-07-15T00:30:00.000Z',
          windowStart: '2026-07-15T00:00:00.000Z',
          windowEnd: '2026-08-15T00:00:00.000Z',
          resetAt: '2026-08-15T00:00:00.000Z',
        },
        productionApps: { state: 'reporting', active: 1, limit: 1 },
      },
    });

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('400 used');
    expect(output).toContain('999,600 remaining');
    expect(output).toContain('Authoritative');
    expect(output).toContain('Active');
    expect(output).toContain('usage and production app limits are enforced');
  });

  it('labels legacy internal accounts exempt without turning shadow data into a quota balance', async () => {
    stub({
      ...ACCOUNT_DETAIL,
      data: {
        ...ACCOUNT_DETAIL.data,
        enforcement: { state: 'exempt', reason: 'legacy_internal' },
        metering: {
          state: 'reporting',
          mode: 'shadow',
          observedCalls: 12,
          coverage: 'partial',
          observedSince: '2026-07-20T00:00:00.000Z',
          windowStart: '2026-07-15T00:00:00.000Z',
          windowEnd: '2026-08-15T00:00:00.000Z',
          remainingMcpCalls: null,
        },
      },
    });

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Exempt');
    expect(output).toContain('Legacy internal account');
    expect(output).toContain('12 observed');
    expect(output).not.toMatch(/remaining/i);
  });

  it('labels rolled-back enforcement honestly', async () => {
    stub({
      ...ACCOUNT_DETAIL,
      data: {
        ...ACCOUNT_DETAIL.data,
        enforcement: { state: 'inactive', reason: 'rolled_back' },
      },
    });

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Rolled back');
    expect(output).toContain('Commercial enforcement is disabled');
    expect(output).not.toContain('Legacy unchanged');
  });

  it('renders typed account reporting outages without inventing usage', async () => {
    stub({
      ...ACCOUNT_DETAIL,
      data: {
        ...ACCOUNT_DETAIL.data,
        metering: {
          state: 'unavailable',
          reason: 'counter_unavailable',
          observedCalls: null,
          coverage: 'unavailable',
          observedSince: null,
          windowStart: null,
          windowEnd: null,
          remainingMcpCalls: null,
        },
        productionApps: { state: 'unavailable', active: null, limit: 5 },
      },
    });

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('Metering');
    expect(output).toContain('Usage reporting unavailable');
    expect(output).toContain('active footprint unavailable; pooled limit 5');
    expect(output).not.toMatch(/\b0 observed\b/i);
  });

  it('maps an inaccessible or unknown account to one actionable not-found failure', async () => {
    stub(
      {
        ok: false,
        code: 'billing_account_not_found',
        error: 'billing account not found',
      },
      404,
    );

    expect(await run(['billing', 'accounts', 'inspect', ACCOUNT_ID, '--json'], ENV, home)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: {
        code: 'not_found',
        message: expect.stringContaining(ACCOUNT_ID),
        next: 'noodle billing accounts list',
      },
    });
  });
});

describe('noodle billing org inspect', () => {
  it('uses an explicit org and emits only the effective billing projection', async () => {
    const requests = stub(ORG_BILLING);

    expect(await run(['billing', 'org', 'inspect', 'acme', '--json'], ENV, home)).toBe(0);
    expect(requests[0]?.url).toBe(`${SERVICE}/v1/orgs/acme/billing`);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, ...ORG_BILLING.data },
    });
    expect(stdout()).not.toContain('billingAccountId');
    expect(stdout()).not.toContain('homeFreeBillingAccountId');
  });

  it('defaults to the linked or saved org and renders honest human state', async () => {
    const saved = {
      ...ORG_BILLING,
      data: { ...ORG_BILLING.data, org: 'saved-org' },
    };
    const requests = stub(saved);

    expect(await run(['billing', 'org', 'inspect'], ENV, home)).toBe(0);
    expect(requests[0]?.url).toBe(`${SERVICE}/v1/orgs/saved-org/billing`);
    const output = stdout();
    expect(output).toContain('saved-org billing');
    expect(output).toContain('1,000,000');
    expect(output).toContain('Not started');
    expect(output).toContain('Usage unavailable');
    expect(output).toContain('Legacy unchanged');
    expect(output).toContain('0 active / 1 shared limit');
    expect(output).toContain('org-attributed active apps');
    expect(output).not.toMatch(/\b0 used\b/i);
  });

  it('shows only organization-attributed shadow usage and the shared production limit', async () => {
    stub({
      ...ORG_BILLING,
      data: {
        ...ORG_BILLING.data,
        metering: {
          state: 'reporting',
          mode: 'shadow',
          observedCalls: 321,
          coverage: 'partial',
          observedSince: '2026-07-20T00:00:00.000Z',
          windowStart: '2026-07-15T00:00:00.000Z',
          windowEnd: '2026-08-15T00:00:00.000Z',
        },
        productionApps: { state: 'reporting', active: 2, limit: 5 },
        pooledObservedCalls: 9_999,
        remainingMcpCalls: 99,
        billingAccountId: 'ba_private',
      },
    });

    expect(await run(['billing', 'org', 'inspect', 'acme'], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('321 observed');
    expect(output).toContain('Org-attributed shadow observation');
    expect(output).toContain('not enforcement or a quota balance');
    expect(output).toContain('2 active / 5 shared limit');
    expect(output).not.toContain('9,999');
    expect(output).not.toContain('ba_private');
    expect(output).not.toMatch(/remaining/i);
  });

  it('shows authoritative organization attribution without the pooled account balance', async () => {
    stub({
      ...ORG_BILLING,
      data: {
        ...ORG_BILLING.data,
        enforcement: { state: 'active', mode: 'authoritative' },
        metering: {
          state: 'reporting',
          mode: 'authoritative',
          coverage: 'complete',
          attributedMcpCalls: 125,
          includedAttributedMcpCalls: 125,
          overageAttributedMcpCalls: 0,
          countingSince: '2026-07-15T00:30:00.000Z',
          windowStart: '2026-07-15T00:00:00.000Z',
          windowEnd: '2026-08-15T00:00:00.000Z',
          resetAt: '2026-08-15T00:00:00.000Z',
        },
        productionApps: { state: 'reporting', active: 1, limit: 1 },
        remainingMcpCalls: 999_600,
        billingAccountId: 'ba_private',
      },
    });

    expect(await run(['billing', 'org', 'inspect', 'acme'], ENV, home)).toBe(0);
    const output = stdout();
    expect(output).toContain('125 attributed');
    expect(output).toContain('Authoritative org attribution');
    expect(output).toContain('Active');
    expect(output).not.toContain('999,600');
    expect(output).not.toContain('ba_private');
    expect(output).not.toMatch(/remaining/i);
  });

  it('never sends a saved login token to a service URL supplied by the project', async () => {
    const cwd = process.cwd();
    const project = mkdtempSync(join(tmpdir(), 'noodle-billing-project-'));
    writeProjectLink({
      org: 'linked-org',
      app: 'linked-app',
      serviceUrl: 'https://attacker.example',
      save: 'project',
      cwd: project,
    });
    process.chdir(project);
    try {
      const requests = stub({
        ...ORG_BILLING,
        data: { ...ORG_BILLING.data, org: 'linked-org' },
      });

      expect(await run(['billing', 'org', 'inspect', '--json'], ENV, home)).toBe(0);
      expect(requests).toEqual([
        {
          url: `${SERVICE}/v1/orgs/linked-org/billing`,
          method: 'GET',
          authorization: `Bearer ${TOKEN}`,
        },
      ]);
    } finally {
      process.chdir(cwd);
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe('billing read failures and grammar', () => {
  it.each([
    ['accounts', 'list', 'extra'],
    ['accounts', 'inspect'],
    ['accounts', 'inspect', ACCOUNT_ID, 'extra'],
    ['org', 'inspect', 'one', 'two'],
    ['accounts', 'list', '--unknown'],
    ['accounts', 'list', '--service', '--json'],
  ])('rejects invalid arguments: %s %s', async (...args) => {
    expect(await run(['billing', ...args], ENV, home)).toBe(2);
    const diagnostic = args.includes('--json') ? stdout() : stderr();
    expect(diagnostic).toContain('billing');
    if (args.includes('--json')) expect(stderr()).toBe('');
  });

  it('returns the standard auth exit when no login exists', async () => {
    writeConfig({ serviceUrl: SERVICE }, home);

    expect(await run(['billing', 'accounts', 'list', '--json'], ENV, home)).toBe(3);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'auth_required', next: 'noodle login' },
    });
  });

  it('returns the standard auth and network exits from service failures', async () => {
    stub({ error: 'forbidden' }, 403);
    expect(await run(['billing', 'accounts', 'list', '--json'], ENV, home)).toBe(3);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'auth_failed' },
    });

    error.mockClear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`offline ${TOKEN}`)));
    expect(await run(['billing', 'accounts', 'list', '--json'], ENV, home)).toBe(4);
    const failure = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      error: { code: string; message: string };
    };
    expect(failure.error.code).toBe('service_unreachable');
    expect(failure.error.message).not.toContain(TOKEN);
  });

  it('keeps the migration command family available', async () => {
    const preview = {
      schemaVersion: 1,
      ready: true,
      organizations: [],
      linkedOrganizations: [],
      fundingSets: [],
      blockers: [],
      grantPolicy: {
        durationDays: 90,
        startsAt: 'billing_enforcement_cutover',
        expiresAt: null,
        eligibility: 'account_cohort_above_capacity',
      },
      previewChecksum: '0'.repeat(64),
    };
    const requests = stub({ ok: true, data: preview });

    expect(await run(['billing', 'migration', 'preview', '--json'], ENV, home)).toBe(0);
    expect(requests[0]?.url).toBe(`${SERVICE}/v1/billing-accounts/migrations/legacy/preview`);
  });

  it('exposes accounts, org, and migration through billing help', async () => {
    expect(await run(['billing', '--help'], ENV, home)).toBe(0);
    expect(stdout()).toContain('accounts');
    expect(stdout()).toContain('org');
    expect(stdout()).toContain('migration');
  });
});

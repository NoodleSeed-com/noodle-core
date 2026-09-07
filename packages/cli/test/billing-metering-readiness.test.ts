import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const ROUTE = `${SERVICE}/v1/billing-accounts/metering/readiness`;
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

const READY_REPORT = {
  schemaVersion: 1,
  checkedAt: '2026-07-16T12:00:00.000Z',
  technicalReadiness: 'ready',
  metering: { mode: 'shadow', coverage: 'partial' },
  enforcement: { state: 'legacy_unchanged' },
  activation: { state: 'not_available' },
  checks: [
    { code: 'durable_postgres', state: 'pass', checkedAt: '2026-07-16T12:00:00.000Z' },
    { code: 'billing_attribution_complete', state: 'pass' },
    { code: 'legacy_platform_quota_retired', state: 'pass' },
    { code: 'key_generation_consistent', state: 'pass' },
    { code: 'prepared_meter_epoch', state: 'pass' },
    { code: 'partition_horizon', state: 'pass' },
    { code: 'receipt_retention', state: 'pass' },
    { code: 'exact_key_tombstones', state: 'pass' },
    { code: 'aggregate_reconciliation', state: 'pass' },
    { code: 'validation_mirror', state: 'pass' },
    { code: 'writer_health', state: 'pass' },
    { code: 'scheduler_health', state: 'pass' },
  ],
  laterCutoverGates: [
    'traffic_fleet_convergence_proof',
    'plan_volume_capacity_proof',
    'nonproduction_fail_closed_drill',
    'grant_expiry_contract',
    'authoritative_activation',
    'protected_production_approval',
  ],
} as const;

const BLOCKED_REPORT = {
  ...READY_REPORT,
  technicalReadiness: 'blocked',
  checks: READY_REPORT.checks.map((check) =>
    check.code === 'exact_key_tombstones'
      ? { ...check, state: 'fail' as const }
      : check.code === 'aggregate_reconciliation'
        ? { ...check, state: 'unknown' as const }
        : check,
  ),
} as const;

const UNAVAILABLE_REPORT = {
  ...READY_REPORT,
  technicalReadiness: 'unavailable',
  metering: { mode: 'not_started', coverage: null },
  checks: READY_REPORT.checks.map((check) => ({ ...check, state: 'unknown' as const })),
} as const;

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-readiness-'));
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing metering readiness', () => {
  it('GETs the super-admin readiness report and preserves a stable JSON envelope', async () => {
    const requests = stubReport(READY_REPORT);

    expect(
      await run(['billing', 'metering', 'readiness', '--service', SERVICE, '--json'], ENV, home),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: ROUTE,
        method: 'GET',
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, readiness: READY_REPORT },
    });
    expect(stderr()).toBe('');
    expect(stdout()).not.toContain(TOKEN);
  });

  it.each([
    ['blocked', BLOCKED_REPORT],
    ['unavailable', UNAVAILABLE_REPORT],
  ] as const)('keeps a %s report machine-readable while exiting 1', async (_state, report) => {
    stubReport(report);

    expect(await run(['billing', 'metering', 'readiness', '--json'], ENV, home)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, readiness: report },
    });
    expect(stderr()).toBe('');
  });

  it.each([
    ['READY', READY_REPORT, 0],
    ['BLOCKED', BLOCKED_REPORT, 1],
    ['UNAVAILABLE', UNAVAILABLE_REPORT, 1],
  ] as const)('renders %s with checks, future gates, and an honest footer', async (verdict, report, exitCode) => {
    stubReport(report);

    expect(await run(['billing', 'metering', 'readiness'], ENV, home)).toBe(exitCode);
    const lines = stdout().split('\n');
    expect(lines[0]).toBe(`Authoritative-meter technical readiness: ${verdict}`);
    expect(stdout()).toContain('durable_postgres');
    expect(stdout()).toContain('Later cutover gates:');
    expect(stdout()).toContain('plan_volume_capacity_proof');
    const metering = `${report.metering.mode.replaceAll('_', ' ')} / ${report.metering.coverage ?? 'unavailable'}`;
    expect(lines.at(-1)).toBe(
      `Metering remains ${metering}. Enforcement is unchanged. No changes were made.`,
    );
    expect(stdout()).not.toContain(TOKEN);
    expect(stderr()).toBe('');
  });

  it.each([
    ['readiness', 'extra'],
    ['readiness', '--unknown'],
    ['readiness', '--service', '--json'],
    ['unknown'],
  ])('rejects invalid metering grammar: %s', async (...args) => {
    expect(await run(['billing', 'metering', ...args], ENV, home)).toBe(2);
    const diagnostic = args.includes('--json') ? stdout() : stderr();
    expect(diagnostic).toContain('billing metering');
    if (args.includes('--json')) expect(stderr()).toBe('');
  });

  it('preserves standard auth, authorization, and network exit codes', async () => {
    writeConfig({ serviceUrl: SERVICE }, home);
    expect(await run(['billing', 'metering', 'readiness', '--json'], ENV, home)).toBe(3);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'auth_required', next: 'noodle login' },
    });

    error.mockClear();
    writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
    stubFailure({ error: 'forbidden' }, 403);
    expect(await run(['billing', 'metering', 'readiness', '--json'], ENV, home)).toBe(3);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'auth_failed' },
    });

    error.mockClear();
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(`offline ${TOKEN}`)));
    expect(await run(['billing', 'metering', 'readiness', '--json'], ENV, home)).toBe(4);
    const failure = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as {
      error: { code: string; message: string };
    };
    expect(failure.error.code).toBe('service_unreachable');
    expect(failure.error.message).not.toContain(TOKEN);
  });

  it('tolerates additive service fields without printing private fields', async () => {
    stubReport({ ...READY_REPORT, privateDatabaseDetail: TOKEN });

    expect(await run(['billing', 'metering', 'readiness', '--json'], ENV, home)).toBe(0);
    expect(stderr()).toBe('');
    expect(stdout()).not.toContain(TOKEN);
  });

  it('exposes the metering readiness command through billing help', async () => {
    expect(await run(['billing', '--help'], ENV, home)).toBe(0);
    expect(stdout()).toContain('metering');
    expect(stdout()).toContain('readiness');
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
}

function stubReport(report: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
      });
      return Response.json({ ok: true, data: report });
    }),
  );
  return requests;
}

function stubFailure(body: unknown, status: number): void {
  vi.unstubAllGlobals();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status })),
  );
}

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}

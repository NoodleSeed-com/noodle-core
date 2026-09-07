import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/prompts.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/prompts.js')>();
  return {
    ...original,
    confirm: vi.fn(),
    isInteractive: vi.fn(() => false),
  };
});

import { run, writeConfig } from '../src/index.js';
import { confirm, isInteractive } from '../src/prompts.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const ROUTE = `${SERVICE}/v1/billing-accounts/enforcement/cohort`;
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

const SEALED_STATUS = {
  schemaVersion: 1,
  cohortKind: 'legacy_internal_v1',
  state: 'sealed',
  sealId: 'becs_00000000-0000-0000-0000-000000000001',
  sealedAt: '2026-07-16T12:00:00.000Z',
  legacyAccountProfile: 'legacy_internal_exempt',
  postSealAccountProfile: 'enforced',
  billingAccountCount: 7,
  profiledAccountCount: 7,
  legacyInternalExemptAccountCount: 5,
  enforcedAccountCount: 2,
  unprofiledAccountCount: 0,
  billingAttributionComplete: true,
  attributionBlockerCount: 0,
} as const;

const UNSEALED_STATUS = {
  ...SEALED_STATUS,
  state: 'unsealed',
  sealId: null,
  sealedAt: null,
  profiledAccountCount: 0,
  legacyInternalExemptAccountCount: 0,
  enforcedAccountCount: 0,
  unprofiledAccountCount: 7,
  billingAttributionComplete: false,
  attributionBlockerCount: 2,
} as const;

const SEAL_RESULT = {
  ...SEALED_STATUS,
  legacyInternalExemptAccountCount: 7,
  enforcedAccountCount: 0,
  replayed: false,
  activationState: 'not_active',
} as const;

const CLASSIFICATION_ONLY_EFFECTS = {
  classificationOnly: true,
  meteringActivated: false,
  usageQuotaEnforcementActivated: false,
  productionAppCapEnforcementActivated: false,
  migrationGrantsActivated: false,
  stripeActivated: false,
  overageBillingActivated: false,
  invoiceEvidenceActivated: false,
} as const;

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
const confirmMock = vi.mocked(confirm);
const isInteractiveMock = vi.mocked(isInteractive);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-enforcement-cohort-'));
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  confirmMock.mockResolvedValue(false);
  isInteractiveMock.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing enforcement cohort status', () => {
  it('reads only aggregate cohort status and returns a classification-only JSON envelope', async () => {
    const requests = stubResult(SEALED_STATUS);

    expect(await run(['billing', 'enforcement', 'cohort', 'status', '--json'], ENV, home)).toBe(0);
    expect(requests).toEqual([
      { url: ROUTE, method: 'GET', body: undefined, authorization: `Bearer ${TOKEN}` },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        cohort: SEALED_STATUS,
        effects: CLASSIFICATION_ONLY_EFFECTS,
      },
    });
    expect(stdout()).not.toContain(TOKEN);
    expect(stderr()).toBe('');
  });

  it('keeps an unsealed or blocked status machine-readable while exiting 1', async () => {
    stubResult(UNSEALED_STATUS);

    expect(await run(['billing', 'enforcement', 'cohort', 'status', '--json'], ENV, home)).toBe(1);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        cohort: UNSEALED_STATUS,
        effects: CLASSIFICATION_ONLY_EFFECTS,
      },
    });
    expect(stderr()).toBe('');
  });

  it('renders aggregate-only status with an explicit no-activation footer', async () => {
    stubResult(SEALED_STATUS);

    expect(await run(['billing', 'enforcement', 'cohort', 'status'], ENV, home)).toBe(0);
    expect(stdout()).toContain('Billing enforcement cohort: SEALED');
    expect(stdout()).toContain('Billing accounts: 7');
    expect(stdout()).toContain('Accounts profiled: 7');
    expect(stdout()).toContain('Legacy internal exempt: 5');
    expect(stdout()).toContain('Enforced profile (not active): 2');
    expect(stdout()).toContain('Attribution blockers: 0');
    expect(stdout()).toContain('Classification only');
    expect(stdout()).toContain('does not activate metering');
    expect(stdout()).toContain('usage-quota enforcement');
    expect(stdout()).toContain('production-app-cap enforcement');
    expect(stdout()).toContain('migration grants');
    expect(stdout()).toContain('Stripe');
    expect(stdout()).toContain('overage billing');
    expect(stdout()).toContain('invoice evidence');
    expect(stdout()).not.toContain(TOKEN);
    expect(stderr()).toBe('');
  });

  it('tolerates additive service fields without printing account details', async () => {
    stubResult({ ...SEALED_STATUS, accounts: [{ billingAccountId: 'ba_private' }] });

    expect(await run(['billing', 'enforcement', 'cohort', 'status', '--json'], ENV, home)).toBe(0);
    expect(stderr()).toBe('');
    expect(stdout()).not.toContain('ba_private');
  });
});

describe('noodle billing enforcement cohort seal', () => {
  it.each([
    ['JSON', ['--json']],
    ['non-interactive human', []],
  ] as const)('requires --yes before any %s request', async (_label, outputFlags) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          'seal-private-key',
          ...outputFlags,
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    const diagnostic = outputFlags.includes('--json') ? stdout() : stderr();
    expect(diagnostic).toContain('confirmation');
    expect(diagnostic).not.toContain('seal-private-key');
    if (outputFlags.includes('--json')) expect(stderr()).toBe('');
  });

  it('makes no request when an interactive operator cancels', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    isInteractiveMock.mockReturnValue(true);
    confirmMock.mockResolvedValue(false);

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          'seal-private-key',
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(stderr()).toContain('cancelled');
    expect(stderr()).not.toContain('seal-private-key');
  });

  it('seals the fixed cohort classification with the exact canonical request', async () => {
    const privateKey = 'seal-private-key';
    const requests = stubResult(SEAL_RESULT);

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          privateKey,
          '--yes',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: `${ROUTE}/seal`,
        method: 'POST',
        body: {
          schemaVersion: 1,
          cohortKind: 'legacy_internal_v1',
          legacyAccountProfile: 'legacy_internal_exempt',
          postSealAccountProfile: 'enforced',
          reason: 'approved cutover cohort',
          idempotencyKey: privateKey,
          confirmed: true,
        },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        cohortSeal: SEAL_RESULT,
        effects: CLASSIFICATION_ONLY_EFFECTS,
      },
    });
    expect(stdout()).not.toContain(privateKey);
    expect(stdout()).not.toContain(TOKEN);
    expect(stderr()).toBe('');
  });

  it('renders replay and the classification-only boundary in human output', async () => {
    stubResult({ ...SEAL_RESULT, replayed: true });

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          'seal-private-key',
          '--yes',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(stdout()).toContain('Billing enforcement cohort: SEALED');
    expect(stdout()).toContain('Billing accounts: 7');
    expect(stdout()).toContain('Accounts profiled: 7');
    expect(stdout()).toContain('existing operation result');
    expect(stdout()).toContain('Classification only');
    expect(stdout()).toContain('does not activate metering');
    expect(stdout()).toContain('usage-quota enforcement');
    expect(stdout()).toContain('production-app-cap enforcement');
    expect(stdout()).toContain('migration grants');
    expect(stdout()).toContain('Stripe');
    expect(stdout()).toContain('overage billing');
    expect(stdout()).toContain('invoice evidence');
    expect(stderr()).toBe('');
  });

  it('redacts the normalized idempotency key from every service failure string field', async () => {
    const privateKey = 'service-echoed-private-key';
    const rawPrivateKey = `  ${privateKey}  `;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          { error: `cohort request ${privateKey} was rejected`, code: privateKey },
          { status: 409 },
        ),
      ),
    );

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          rawPrivateKey,
          '--yes',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    expect(stdout()).toContain('[redacted]');
    expect(stdout()).toContain('--idempotency-key <same-private-key>');
    expect(stdout()).not.toContain(privateKey);
    expect(stdout()).not.toContain(rawPrivateKey);
    expect(stderr()).toBe('');
  });

  it('rejects an incomplete schema-valid-looking seal result', async () => {
    stubResult({
      ...SEAL_RESULT,
      profiledAccountCount: 6,
      legacyInternalExemptAccountCount: 6,
      unprofiledAccountCount: 1,
    });

    expect(
      await run(
        [
          'billing',
          'enforcement',
          'cohort',
          'seal',
          '--reason',
          'approved cutover cohort',
          '--idempotency-key',
          'seal-private-key',
          '--yes',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(1);
    expect(stderr()).toBe('');
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'command_failed' },
    });
  });

  it.each([
    ['cohort', 'seal', '--idempotency-key', 'k', '--yes'],
    ['cohort', 'seal', '--reason', 'r', '--yes'],
    ['cohort', 'seal', '--reason', 'r', '--idempotency-key', 'k', '--unknown', '--yes'],
    ['cohort', 'unknown'],
  ])('rejects incomplete enforcement cohort grammar', async (...args) => {
    expect(await run(['billing', 'enforcement', ...args], ENV, home)).toBe(2);
    expect(stderr()).toContain('billing enforcement cohort');
  });
});

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

function stubResult(result: unknown): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({ ok: true, data: result });
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}

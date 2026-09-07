import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const PREPARE_ROUTE = `${SERVICE}/v1/billing-accounts/metering/validation/prepare`;
const RETIRE_ROUTE = `${SERVICE}/v1/billing-accounts/metering/validation/retire`;
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };
const RESULT = {
  schemaVersion: 1,
  epochId: 'bmev_00000000-0000-0000-0000-000000000001',
  mode: 'validation',
  state: 'prepared',
  replayed: false,
  preparedAt: '2026-07-16T12:00:00.000Z',
  retiredAt: null,
  retryIdentityVersion: 1,
  writerContractVersion: 1,
  serviceReleaseSha: 'a'.repeat(40),
  meteringMode: 'shadow',
  enforcementMode: 'legacy_unchanged',
} as const;

let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-validation-'));
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing metering validation lifecycle', () => {
  it('requires explicit confirmation before making a non-interactive mutation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(
      await run(
        [
          'billing',
          'metering',
          'validation',
          'prepare',
          '--reason',
          'validation soak',
          '--idempotency-key',
          'prepare-v1',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      error: { code: 'confirmation_required' },
    });
  });

  it('prepares a validation-only epoch and preserves a stable JSON envelope', async () => {
    const requests = stubResult(RESULT);
    const exitCode = await run(
      [
        'billing',
        'metering',
        'validation',
        'prepare',
        '--reason',
        'validation soak',
        '--idempotency-key',
        'prepare-v1',
        '--yes',
        '--json',
      ],
      ENV,
      home,
    );
    expect(stderr()).toBe('');
    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      {
        url: PREPARE_ROUTE,
        body: {
          schemaVersion: 1,
          mode: 'validation',
          reason: 'validation soak',
          idempotencyKey: 'prepare-v1',
          confirmed: true,
        },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, validationEpoch: RESULT },
    });
    expect(stdout()).not.toContain(TOKEN);
  });

  it('retires an epoch and states that enforcement remains unchanged', async () => {
    const requests = stubResult({
      ...RESULT,
      state: 'retired',
      retiredAt: '2026-07-16T13:00:00.000Z',
    });
    const exitCode = await run(
      [
        'billing',
        'metering',
        'validation',
        'retire',
        '--epoch',
        RESULT.epochId,
        '--reason',
        'soak complete',
        '--idempotency-key',
        'retire-v1',
        '--yes',
      ],
      ENV,
      home,
    );
    expect(stderr()).toBe('');
    expect(exitCode).toBe(0);
    expect(requests).toEqual([
      {
        url: RETIRE_ROUTE,
        body: {
          schemaVersion: 1,
          epochId: RESULT.epochId,
          reason: 'soak complete',
          idempotencyKey: 'retire-v1',
          confirmed: true,
        },
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(stdout()).toContain('Validation epoch: RETIRED');
    expect(stdout()).toContain(RESULT.epochId);
    expect(stdout()).toContain('Metering remains shadow. Enforcement is unchanged.');
  });

  it('does not disclose the private idempotency key in human service-failure recovery', async () => {
    const privateKey = 'private-validation-key-human';
    stubServiceFailure();

    expect(
      await run(
        [
          'billing',
          'metering',
          'validation',
          'prepare',
          '--reason',
          'validation soak',
          '--idempotency-key',
          privateKey,
          '--yes',
        ],
        ENV,
        home,
      ),
    ).toBe(1);

    expect(stderr()).toContain('--idempotency-key <same-private-key>');
    expect(stderr()).not.toContain(privateKey);
  });

  it('does not disclose the private idempotency key in JSON service-failure recovery', async () => {
    const privateKey = 'private-validation-key-json';
    stubServiceFailure();

    expect(
      await run(
        [
          'billing',
          'metering',
          'validation',
          'prepare',
          '--reason',
          'validation soak',
          '--idempotency-key',
          privateKey,
          '--yes',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(1);

    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      error: {
        next: expect.stringContaining('--idempotency-key <same-private-key>'),
      },
    });
    expect(stderr()).not.toContain(privateKey);
  });

  it.each([
    ['validation', 'prepare', '--reason', 'r', '--yes'],
    ['validation', 'prepare', '--idempotency-key', 'k', '--yes'],
    ['validation', 'retire', '--reason', 'r', '--idempotency-key', 'k', '--yes'],
    ['validation', 'unknown'],
  ])('rejects incomplete validation grammar', async (...args) => {
    expect(await run(['billing', 'metering', ...args], ENV, home)).toBe(2);
    expect(stderr()).toContain('billing metering validation');
  });
});

interface CapturedRequest {
  readonly url: string;
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
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({ ok: true, data: result });
    }),
  );
  return requests;
}

function stubServiceFailure(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json(
        { error: 'meter validation is temporarily unavailable', code: 'validation_unavailable' },
        { status: 503 },
      ),
    ),
  );
}

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

function stderr(): string {
  return error.mock.calls.map((call) => String(call[0])).join('\n');
}

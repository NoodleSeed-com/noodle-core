import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://cloud.noodleseed.dev';
const ROOT = `${SERVICE}/v1/platform-auth/migration`;
const SHA = 'a'.repeat(40);
const PREVIEW_CHECKSUM = 'c'.repeat(64);
const PRIVATE_KEY = 'private-recovery-key';
const PRIVATE_REASON = 'approved terminal recovery';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };

let home: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-platform-auth-recovery-'));
  writeConfig({ serviceUrl: SERVICE, authToken: 'SECRET_TOKEN' }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle platform-auth terminal outbox recovery', () => {
  it('documents and previews the bounded aggregate-only recovery action', async () => {
    expect(await run(['platform-auth', '--help'], ENV, home)).toBe(0);
    expect(stdout()).toContain('recover-outbox');
    log.mockClear();
    const requests = stubService({ [`${ROOT}/preview`]: recoveryPreview() });

    expect(
      await run(
        [
          'platform-auth',
          'migration',
          'preview',
          '--operation',
          'recover_outbox',
          '--batch-size',
          '25',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/preview`,
        method: 'POST',
        redirect: 'manual',
        body: { schemaVersion: 1, operation: 'recover_outbox', batchSize: 25 },
      }),
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      data: {
        migration: {
          operation: 'recover_outbox',
          target: { batchSize: 25, terminalCount: 2 },
        },
      },
    });
  });

  it('requires confirmation before sending terminal recovery authority', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await run(recoveryArgs('--json'), ENV, home)).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: false,
      error: { code: 'confirmation_required', next: expect.stringContaining('--yes') },
    });
  });

  it.each([
    { rejected: 0, expectedExit: 0 },
    { rejected: 1, expectedExit: 1 },
  ])('sends one fenced recovery and exits truthfully for $rejected rejected rows', async (testCase) => {
    const result = recoveryResult(testCase.rejected);
    const requests = stubService({ [`${ROOT}/recover-outbox`]: result });
    expect(await run(recoveryArgs('--yes', '--json'), ENV, home)).toBe(testCase.expectedExit);
    expect(requests).toEqual([
      expect.objectContaining({
        url: `${ROOT}/recover-outbox`,
        method: 'POST',
        authorization: 'Bearer SECRET_TOKEN',
        redirect: 'manual',
        body: {
          schemaVersion: 1,
          expectedGeneration: 4,
          releaseSha: SHA,
          previewChecksum: PREVIEW_CHECKSUM,
          idempotencyKey: PRIVATE_KEY,
          reason: PRIVATE_REASON,
          confirmed: true,
          batchSize: 25,
        },
      }),
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
      ok: true,
      data: { service: SERVICE, migration: result },
    });
    expect(stdout()).not.toContain(PRIVATE_KEY);
    expect(stdout()).not.toContain(PRIVATE_REASON);
    expect(stdout()).not.toMatch(/person@example|workos-user/);
  });
});

function snapshot() {
  return {
    schemaVersion: 1,
    releaseSha: SHA,
    rollout: {
      generation: 4,
      workosPercentage: 10,
      lifecycle: 'workos',
      canaryClientSetHash: 'd'.repeat(64),
      canaryClientCount: 1,
      recoveryClientSetHash: 'e'.repeat(64),
      recoveryClientCount: 1,
      workosDefaultSince: null,
    },
    inventory: {
      state: 'unavailable',
      phase: null,
      remotePages: 0,
      remoteUsers: 0,
      localSubjects: 0,
      candidateCount: 0,
      excludedCount: 0,
      checksum: null,
      blockers: [],
    },
    import: {
      state: 'not_started',
      total: 0,
      pending: 0,
      reconcileRequired: 0,
      linked: 0,
      blocked: 0,
      failed: 0,
      activeLeases: 0,
      nextRetryAt: null,
    },
    synchronization: {
      outbox: { status: 'ready', pending: 2, lastSuccessAgeSeconds: 12 },
      events: { status: 'ready', lastSuccessAgeSeconds: 12 },
    },
    remoteVerification: {
      state: 'ready',
      checkedCount: 0,
      candidateCount: 0,
      verifiedCount: 0,
      retryAt: null,
    },
  } as const;
}

function recoveryPreview() {
  return {
    ...snapshot(),
    operation: 'recover_outbox',
    ready: true,
    previewChecksum: PREVIEW_CHECKSUM,
    blockers: [],
    target: {
      batchSize: 25,
      terminalCount: 2,
      terminalSetHash: 'f'.repeat(64),
    },
  } as const;
}

function recoveryResult(rejected: number) {
  return {
    ...snapshot(),
    operation: 'recover_outbox',
    replayed: false,
    batch: { attempted: 2, recovered: 2 - rejected, rejected },
  } as const;
}

function recoveryArgs(...extra: string[]): string[] {
  return [
    'platform-auth',
    'migration',
    'recover-outbox',
    '--batch-size',
    '25',
    '--expected-generation',
    '4',
    '--release-sha',
    SHA,
    '--preview-checksum',
    PREVIEW_CHECKSUM,
    '--idempotency-key',
    PRIVATE_KEY,
    '--reason',
    PRIVATE_REASON,
    ...extra,
  ];
}

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly redirect: RequestRedirect | undefined;
  readonly body?: Record<string, unknown>;
}

function stubService(responses: Readonly<Record<string, unknown>>): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({
        url,
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
        redirect: init?.redirect,
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) as Record<string, unknown> }
          : {}),
      });
      const response = responses[url];
      if (response === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ ok: true, data: response }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map(([value]) => String(value)).join('\n');
}

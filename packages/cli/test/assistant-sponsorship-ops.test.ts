import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistant } from '../src/commands/assistant-ops.js';
import { writeConfig } from '../src/config.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const RESPONSE = JSON.parse(
  readFileSync(
    join(process.cwd(), 'contract', 'v1', 'managed-assistant-sponsorship-response.json'),
    'utf8',
  ),
) as { ok: true; data: { billingAccountId: string; grants: readonly Record<string, unknown>[] } };
const ACCOUNT = RESPONSE.data.billingAccountId;
let home: string;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-assistant-sponsorship-'));
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

function stub(body: unknown) {
  const requests: Array<{
    url: string;
    method: string;
    body?: unknown;
    authorization: string | null;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json(body);
    }),
  );
  return requests;
}

describe('noodle assistant sponsorship', () => {
  it('inspects account and fleet sponsorship without exposing the credential', async () => {
    const requests = stub(RESPONSE);
    expect(await runAssistant(['sponsorship', 'inspect', ACCOUNT, '--json'], {}, home)).toBe(0);
    expect(requests).toEqual([
      {
        url: `${SERVICE}/v1/billing-accounts/${ACCOUNT}/managed-assistant-sponsorship`,
        method: 'GET',
        authorization: `Bearer ${TOKEN}`,
      },
    ]);
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({
      ok: true,
      data: { service: SERVICE, billingAccountId: ACCOUNT, totalTurnsPerDay: 600 },
    });
    expect(log.mock.calls.join('\n')).not.toContain(TOKEN);
  });

  it('creates an expiring idempotent bonus grant with the exact operator payload', async () => {
    const mutation = {
      ok: true,
      data: { replayed: false, grant: RESPONSE.data.grants[0], sponsorship: RESPONSE.data },
    };
    const requests = stub(mutation);
    expect(
      await runAssistant(
        [
          'sponsorship',
          'grant',
          ACCOUNT,
          '--turns-per-day',
          '500',
          '--expires-at',
          '2026-09-30T00:00:00Z',
          '--reason',
          'Design partner sponsored beta',
          '--idempotency-key',
          'customer-trial-001',
          '--json',
        ],
        {},
        home,
      ),
    ).toBe(0);
    expect(requests[0]).toMatchObject({
      url: `${SERVICE}/v1/billing-accounts/${ACCOUNT}/managed-assistant-sponsorship/grants`,
      method: 'POST',
      body: {
        additionalTurnsPerDay: 500,
        expiresAt: '2026-09-30T00:00:00.000Z',
        reason: 'Design partner sponsored beta',
        idempotencyKey: 'customer-trial-001',
      },
    });
  });

  it('rejects a perpetual or unbounded grant before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await runAssistant(
        [
          'sponsorship',
          'grant',
          ACCOUNT,
          '--turns-per-day',
          '100001',
          '--reason',
          'too much',
          '--idempotency-key',
          'customer-trial-002',
        ],
        {},
        home,
      ),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

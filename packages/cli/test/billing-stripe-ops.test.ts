import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, writeConfig } from '../src/index.js';

const SERVICE = 'https://svc.example';
const TOKEN = 'SECRET_TOKEN';
const ACCOUNT_ID = 'ba_00000000-0000-4000-8000-000000000001';
const ENV = { NOODLE_DISABLE_UPDATE_CHECK: '1' };
let home: string;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noodle-billing-stripe-'));
  writeConfig({ serviceUrl: SERVICE, authToken: TOKEN }, home);
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe('noodle billing accounts Stripe actions', () => {
  it('creates a checkout with explicit plan/cadence and stable JSON output', async () => {
    const requests = stub({
      ok: true,
      data: {
        url: 'https://checkout.stripe.com/c/pay/test',
        expiresAt: '2026-07-17T13:00:00.000Z',
        replayed: false,
        outcome: 'resumed',
      },
    });
    expect(
      await run(
        [
          'billing',
          'accounts',
          'checkout',
          ACCOUNT_ID,
          '--plan',
          'pro',
          '--interval',
          'year',
          '--idempotency-key',
          'checkout-1',
          '--json',
        ],
        ENV,
        home,
      ),
    ).toBe(0);
    expect(requests).toEqual([
      {
        url: `${SERVICE}/v1/billing-accounts/${ACCOUNT_ID}/checkout`,
        method: 'POST',
        authorization: `Bearer ${TOKEN}`,
        body: { plan: 'pro', interval: 'year', idempotencyKey: 'checkout-1' },
      },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      ok: true,
      data: {
        service: SERVICE,
        url: 'https://checkout.stripe.com/c/pay/test',
        expiresAt: '2026-07-17T13:00:00.000Z',
        replayed: false,
        outcome: 'resumed',
      },
    });
    expect(stdout()).not.toContain(TOKEN);
  });

  it('creates a portal session and prints the hosted URL', async () => {
    const requests = stub({
      ok: true,
      data: { url: 'https://billing.stripe.com/p/session/test' },
    });
    expect(await run(['billing', 'accounts', 'portal', ACCOUNT_ID], ENV, home)).toBe(0);
    expect(requests[0]).toMatchObject({
      url: `${SERVICE}/v1/billing-accounts/${ACCOUNT_ID}/portal`,
      method: 'POST',
    });
    expect(stdout()).toContain('https://billing.stripe.com/p/session/test');
  });

  it('requires checkout choices before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await run(['billing', 'accounts', 'checkout', ACCOUNT_ID, '--plan', 'free'], ENV, home),
    ).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error.mock.calls.join('\n')).toContain('--plan must be pro or scale');
  });
});

function stub(responseBody: unknown) {
  const requests: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: unknown;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input.toString(),
        method: init?.method ?? 'GET',
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return Response.json(responseBody);
    }),
  );
  return requests;
}

function stdout(): string {
  return log.mock.calls.map((call) => String(call[0])).join('\n');
}

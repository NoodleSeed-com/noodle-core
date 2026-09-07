/** Runnable browser mount check; opening the assistant or executing a workflow is deliberately separate. */
export function embedBrowserContractTest(): string {
  return `import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';

test('assistant mounts in the running customer application', { timeout: 30_000 }, async () => {
  const origin = process.env.PUBLIC_APP_ORIGIN;
  assert.ok(origin, 'Set PUBLIC_APP_ORIGIN to the running local or approved sandbox application.');
  assert.equal(new URL(origin).origin, origin, 'PUBLIC_APP_ORIGIN must be an exact origin, without a path.');
  const browser = await chromium.launch({ headless: true });
  try {
    // If the application requires login before this page, reuse its existing login fixture here.
    // Never commit a real cookie/token or log a session. This test never submits a turn or action.
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', () => failures.push('browser JavaScript failed'));
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(
      customElements.get('noodle-assistant') && document.querySelector('noodle-assistant')?.shadowRoot,
    ));
    assert.deepEqual(failures, []);
    assert.equal(await page.locator('noodle-assistant').count(), 1);
  } finally { await browser.close(); }
});
// This proves mounting only. Separately prove real session/tenant rules, CSP, one read and a confirmed
// action or handoff, using approved sandbox data. Installed files and a mounted component are not readiness.
`;
}

/** Executable customer-side contract tests; synthetic identities are not proof of the real login seam. */
export function nextSessionContractTest(): string {
  return `import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authenticateAssistantRequest } from '../lib/noodle-assistant-auth';

vi.mock('../lib/noodle-assistant-auth', () => ({ authenticateAssistantRequest: vi.fn() }));

const session = {
  token: 'synthetic-test-session', expiresAt: '2030-01-01T00:00:00Z',
  endpoints: { turns: 'https://cloud.example/turns', toolConfirmations: 'https://cloud.example/confirmations' },
};
const upstream = vi.fn<typeof fetch>();
let POST: (request: Request) => Promise<Response>;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('PUBLIC_APP_ORIGIN', 'https://app.example');
  vi.stubEnv('NOODLE_SERVICE_URL', 'https://cloud.example');
  vi.stubEnv('NOODLE_ASSISTANT_CLIENT_ID', 'synthetic-client');
  vi.stubEnv('NOODLE_ASSISTANT_CLIENT_SECRET', 'synthetic-test-credential');
  upstream.mockReset().mockImplementation(async () => Response.json(session));
  vi.stubGlobal('fetch', upstream);
  vi.mocked(authenticateAssistantRequest).mockReset().mockResolvedValue(null);
  ({ POST } = await import('../app/api/assistant/session/route'));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function request(body: unknown = {}, origin = 'https://app.example', contentType = 'application/json') {
  return new Request('https://app.example/api/assistant/session', {
    method: 'POST', headers: { origin, 'content-type': contentType }, body: JSON.stringify(body),
  });
}

describe('generated assistant route (synthetic contract)', () => {
  it('returns JSON 401, not an HTML redirect, for a signed-out request', async () => {
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects wrong origins and form requests before reading the application session', async () => {
    expect((await POST(request({}, 'https://attacker.example'))).status).toBe(403);
    expect((await POST(request({}, 'https://app.example', 'text/plain'))).status).toBe(415);
    expect(authenticateAssistantRequest).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it('does not let browser JSON replace the backend identity or tenant routes', async () => {
    vi.mocked(authenticateAssistantRequest).mockResolvedValue({ user: { id: 'person-a', tenant: 'tenant-a' } });
    expect((await POST(request({ user: { id: 'person-b', tenant: 'tenant-b' } }))).status).toBe(400);
    expect((await POST(request({ routing: { endpoints: { api: 'https://attacker.example' } } }))).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('exchanges only the verified identity and returns the short-lived session', async () => {
    vi.mocked(authenticateAssistantRequest).mockResolvedValue({ user: { id: 'person-a', tenant: 'tenant-a' } });
    const response = await POST(request({ context: { page: 'tasks' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(session);
    expect(JSON.parse(String(upstream.mock.calls[0]?.[1]?.body))).toMatchObject({
      user: { id: 'person-a', tenant: 'tenant-a' }, origin: 'https://app.example', context: { page: 'tasks' },
    });
  });
  it('fails closed on a cross-tenant sign-in refusal without retrying the ticket', async () => {
    vi.mocked(authenticateAssistantRequest).mockResolvedValue({ user: { id: 'person-a' }, signInTicket: 'synthetic-bound-ticket' });
    upstream.mockResolvedValue(Response.json({ code: 'elevation_tenant_mismatch' }, { status: 403 }));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe('elevation_tenant_mismatch');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
// Add acceptance tests using your application's own signed-out, tenant-A and tenant-B session fixtures.
// These synthetic tests prove route wiring, not the membership rules inside authenticateAssistantRequest.
`;
}

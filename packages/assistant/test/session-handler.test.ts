import { describe, expect, it, vi } from 'vitest';
import { type AssistantSessionIdentity, createAssistantSessionHandler } from '../src/server.js';

const configuration = {
  serviceUrl: 'https://cloud.example',
  origin: 'https://app.example',
  clientId: 'embed_fixture',
  clientSecret: 'synthetic-backend-credential',
};
const session = {
  token: 'synthetic-session',
  expiresAt: '2030-01-01T00:00:00Z',
  endpoints: {
    turns: 'https://cloud.example/v1/assistant/turns',
    toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
  },
};

function request(body: unknown = {}, headers: HeadersInit = {}) {
  return new Request('https://app.example/api/assistant/session', {
    method: 'POST',
    headers: { origin: configuration.origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function fixture(identity: AssistantSessionIdentity | null = { user: { id: 'person-a' } }) {
  const authenticate = vi.fn().mockResolvedValue(identity);
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(session));
  const handler = createAssistantSessionHandler(
    { ...configuration, authenticate },
    { fetch: fetchMock },
  );
  return { handler, authenticate, fetchMock };
}

describe('maintained customer session handler', () => {
  it.each([
    ['wrong origin', { origin: 'https://app.example.attacker.test' }, 403],
    ['missing origin', { origin: '' }, 403],
    ['null origin', { origin: 'null' }, 403],
    ['form body', { 'content-type': 'application/x-www-form-urlencoded' }, 415],
    ['plain text', { 'content-type': 'text/plain' }, 415],
  ])('rejects %s before authentication or exchange', async (_name, headers, status) => {
    const { handler, authenticate, fetchMock } = fixture();
    const result = await handler(request({}, headers));
    expect(result.status).toBe(status);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('content-type')).toContain('application/json');
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods with a JSON 405 and Allow header', async () => {
    const { handler, authenticate, fetchMock } = fixture();
    const result = await handler(new Request('https://app.example/api/assistant/session'));
    expect(result.status).toBe(405);
    expect(result.headers.get('allow')).toBe('POST');
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns JSON 401 without a login redirect for signed-out callers', async () => {
    const { handler, fetchMock } = fixture(null);
    const result = await handler(request());
    expect(result.status).toBe(401);
    expect(result.headers.get('location')).toBeNull();
    expect(await result.json()).toEqual({
      code: 'authentication_required',
      error: 'authentication required',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(
    [
      null,
      [],
      { user: { id: 'attacker' } },
      { routing: { endpoints: {} } },
      { signInTicket: 'browser-cannot-choose-login-transaction' },
      { claims: { admin: true } },
      { context: { nested: {} } },
      { context: { long: 'x'.repeat(2001) } },
      { context: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, true])) },
      { context: { ['x'.repeat(81)]: true } },
    ].map((body) => [body]),
  )('rejects invalid or authority-bearing browser input %#', async (body) => {
    const { handler, fetchMock } = fixture();
    const result = await handler(request(body));
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '{',
    '{"context":{"number":1e400}}',
  ])('rejects malformed/non-finite JSON %s', async (body) => {
    const { handler, fetchMock } = fixture();
    const result = await handler(new Request(request(), { body }));
    expect(result.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces a streaming byte limit without trusting Content-Length', async () => {
    const { handler, fetchMock } = fixture();
    const result = await handler(request({ context: { page: 'x'.repeat(16 * 1024) } }));
    expect(result.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { clientSecret: undefined },
    { clientId: '' },
    { clientId: 'invalid:id' },
    { origin: 'https://*.example' },
    { origin: 'http://app.example' },
    { origin: 'https://app.example/' },
    { serviceUrl: 'http://cloud.example' },
    { serviceUrl: 'https://user:password@cloud.example' },
    { serviceUrl: 'https://cloud.example/app/mcp' },
  ])('fails closed on invalid operator configuration %j', async (override) => {
    const { authenticate, fetchMock } = fixture();
    const handler = createAssistantSessionHandler(
      { ...configuration, ...override, authenticate },
      { fetch: fetchMock },
    );
    const result = await handler(request());
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({
      code: 'assistant_not_configured',
      error: 'assistant is not configured',
    });
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows exact loopback development configuration', async () => {
    const { authenticate, fetchMock } = fixture();
    const handler = createAssistantSessionHandler(
      {
        ...configuration,
        authenticate,
        origin: 'http://localhost:3000',
        serviceUrl: 'http://127.0.0.1:3001',
      },
      { fetch: fetchMock },
    );
    expect((await handler(request({}, { origin: 'http://localhost:3000' }))).status).toBe(200);
  });

  it('uses backend identity/routing only and forwards the session without credentials or inbound headers', async () => {
    const identity = {
      user: { id: 'person-a', tenant: 'tenant-a', scopes: ['tasks:read'] },
      routing: { endpoints: { customer_api: 'https://tenant-a.example/api' } },
      preferences: { locale: 'en-GB' },
      claims: { plan: 'pro' },
    };
    const { handler, fetchMock } = fixture(identity);
    const result = await handler(
      request(
        { context: { page: 'tasks', count: 2, enabled: true, selection: null } },
        {
          cookie: 'synthetic-customer-cookie',
          authorization: 'Bearer synthetic-inbound-token',
          'content-type': 'Application/JSON; charset=utf-8',
        },
      ),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(session);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://cloud.example/v1/assistant/sessions');
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(init)).not.toMatch(/synthetic-customer-cookie|synthetic-inbound-token/);
    expect(JSON.parse(String(init?.body))).toEqual({
      origin: configuration.origin,
      ...identity,
      context: { page: 'tasks', count: 2, enabled: true, selection: null },
    });
  });

  it('spends only a backend-bound sign-in ticket and preserves automatic resume', async () => {
    const { handler, fetchMock } = fixture({
      user: { id: 'person-a' },
      signInTicket: 'synthetic-bound-ticket',
      resume: true,
    });
    const continued = {
      ...session,
      continuedAfterAuthentication: true,
      resume: { tool: 'read_tasks' },
    };
    fetchMock.mockResolvedValue(Response.json(continued));
    const result = await handler(request());
    expect(await result.json()).toEqual(continued);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      signInTicket: 'synthetic-bound-ticket',
      resume: true,
    });
  });

  it('rejects context rather than silently dropping it during sign-in continuation', async () => {
    const { handler, fetchMock } = fixture({
      user: { id: 'person-a' },
      signInTicket: 'synthetic-bound-ticket',
    });
    expect((await handler(request({ context: { page: 'home' } }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the machine-readable cross-tenant refusal without retrying or echoing upstream content', async () => {
    const { handler, fetchMock } = fixture({
      user: { id: 'person-a' },
      signInTicket: 'synthetic-bound-ticket',
    });
    fetchMock.mockResolvedValue(
      Response.json(
        { code: 'elevation_tenant_mismatch', error: 'private upstream details' },
        { status: 403 },
      ),
    );
    const result = await handler(request());
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({
      code: 'elevation_tenant_mismatch',
      error: 'assistant sign-in was refused',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not expose authentication exceptions or confuse them with signed-out callers', async () => {
    const { handler, authenticate, fetchMock } = fixture();
    authenticate.mockRejectedValue(new Error('private identity-service details'));
    const result = await handler(request());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('private');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { user: { id: '' } },
    Response.redirect('https://app.example/login'),
  ])('returns a sanitized JSON failure for a broken authentication adapter %#', async (identity) => {
    const { handler, authenticate, fetchMock } = fixture();
    authenticate.mockResolvedValue(identity);
    const result = await handler(request());
    expect(result.status).toBe(503);
    expect(result.headers.get('location')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds stalled authentication and never exchanges after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const { handler, authenticate, fetchMock } = fixture();
      let finish: ((identity: AssistantSessionIdentity) => void) | undefined;
      authenticate.mockReturnValue(
        new Promise<AssistantSessionIdentity>((resolve) => {
          finish = resolve;
        }),
      );
      const pending = handler(request());
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending).status).toBe(504);
      finish?.({ user: { id: 'person-a' } });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a stalled streaming body at the deadline without an exchange', async () => {
    vi.useFakeTimers();
    try {
      const { handler, fetchMock } = fixture();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const pending = handler(new Request(request(), { body, duplex: 'half' } as RequestInit));
      await vi.advanceTimersByTimeAsync(15_000);
      expect((await pending).status).toBe(504);
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'network',
    'html',
    'unauthorized',
  ])('sanitizes %s exchange failure and never retries', async (failure) => {
    const { handler, fetchMock } = fixture();
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('private network details'));
    else
      fetchMock.mockResolvedValue(
        new Response('private upstream details', { status: failure === 'html' ? 502 : 401 }),
      );
    const result = await handler(request());
    expect(result.status).toBe(502);
    expect(await result.json()).toEqual({
      code: 'session_exchange_failed',
      error: 'assistant session exchange failed',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

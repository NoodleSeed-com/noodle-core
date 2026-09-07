import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ASSISTANT_ELEVATION_REFUSAL_CODES,
  type AssistantSession,
  AssistantSessionExchangeError,
  type CreateAssistantSessionInput,
  createAssistantSession,
} from '../src/server.js';

const SESSION_BODY = {
  token: 'browser-token',
  expiresAt: '2030-01-01T00:00:00Z',
  endpoints: {
    turns: 'https://cloud.example/v1/assistant/turns',
    toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
  },
};

const BASE_INPUT = {
  serviceUrl: 'https://cloud.example',
  clientId: 'client_123',
  clientSecret: 'server-only-secret',
  origin: 'https://app.example.com',
  user: { id: 'user_123' },
} as const;

const jsonResponse = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('createAssistantSession', () => {
  it('exchanges backend-verified identity without returning the client secret', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          token: 'browser-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    const result = await createAssistantSession(
      {
        serviceUrl: 'https://cloud.example',
        clientId: 'embed_123',
        clientSecret: 'server-only-secret',
        origin: 'https://app.example.com',
        user: { id: 'user_123', email: 'person@example.com' },
        claims: { displayName: 'Person Example', accountTier: 'pro' },
        context: { page: 'billing' },
        preferences: { locale: 'en-GB', timeZone: 'Europe/London' },
        routing: {
          endpoints: {
            customer_api: 'https://tenant-a.api.example.com/v1',
          },
        },
      },
      { fetch: fetchMock },
    );

    expect(result.token).toBe('browser-token');
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent.claims).toEqual({ displayName: 'Person Example', accountTier: 'pro' });
    expect(sent.preferences).toEqual({ locale: 'en-GB', timeZone: 'Europe/London' });
    expect(sent.routing).toEqual({
      endpoints: { customer_api: 'https://tenant-a.api.example.com/v1' },
    });
    expect(result.endpoints.toolConfirmations).toContain('/tool-confirmations');
    expect(JSON.stringify(result)).not.toContain('server-only-secret');
    expect(JSON.stringify(result)).not.toContain('tenant-a.api.example.com');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.example/v1/assistant/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }),
      }),
    );
    // A fresh mint must never carry the sign-in key: the service branches on its mere presence.
    expect('signInTicket' in sent).toBe(false);
  });
});

describe('createAssistantSession sign-in elevation', () => {
  it('spends a sign-in ticket: same endpoint, same credentials, ticket in the body', async () => {
    // The service answers an elevation with 200 where a fresh mint is 201; both are success.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION_BODY, 200));

    const session = await createAssistantSession(
      {
        ...BASE_INPUT,
        signInTicket: 'elv_abc',
        claims: { accountTier: 'pro' },
        // Elevation is the first authenticated moment: the only chance a routed connector's
        // session gets its backend-verified customer routes.
        routing: { endpoints: { customer_api: 'https://tenant-a.api.example.com/v1' } },
      },
      { fetch: fetchMock },
    );

    expect(session.token).toBe('browser-token');
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent.signInTicket).toBe('elv_abc');
    expect(sent.user).toEqual({ id: 'user_123' });
    expect(sent.origin).toBe('https://app.example.com');
    expect(sent.claims).toEqual({ accountTier: 'pro' });
    expect(sent.routing).toEqual({
      endpoints: { customer_api: 'https://tenant-a.api.example.com/v1' },
    });
    // The service ignores context on the elevation leg, so sending it would be a lie.
    expect('context' in sent).toBe(false);
  });

  it('serializes the resume override on the elevation arm, and false travels too', async () => {
    // Resume is ON by default server-side, so only an explicit value is sent — and an explicit
    // `false` (the integrator's own affordance) must survive serialization, never be dropped by a
    // truthiness spread.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION_BODY, 200));
    await createAssistantSession(
      { ...BASE_INPUT, signInTicket: 'elv_abc', resume: false },
      { fetch: fetchMock },
    );
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent.resume).toBe(false);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(SESSION_BODY, 200));
    await createAssistantSession({ ...BASE_INPUT, signInTicket: 'elv_abc' }, { fetch: fetchMock });
    const omitted = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect('resume' in omitted).toBe(false);
  });

  it('can suppress visual restoration without changing service-side retention', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(SESSION_BODY, 200));
    const session = await createAssistantSession(
      {
        ...BASE_INPUT,
        signInTicket: 'elv_abc',
        restoreConversation: false,
      },
      { fetch: fetchMock },
    );
    expect(session.endpoints.transcript).toBeUndefined();
    const sent = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect('restoreConversation' in sent).toBe(false);
  });

  it('refuses context beside a sign-in ticket before any request is made', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      createAssistantSession(
        {
          ...BASE_INPUT,
          signInTicket: 'elv_abc',
          context: { page: 'billing' },
        } as CreateAssistantSessionInput,
        { fetch: fetchMock },
      ),
    ).rejects.toThrow(/context does not apply/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the wrong pair from typechecking, like the sessionEndpoint/embedId XOR', () => {
    expectTypeOf({
      ...BASE_INPUT,
      signInTicket: 'elv_abc',
    }).toExtend<CreateAssistantSessionInput>();
    expectTypeOf({
      ...BASE_INPUT,
      signInTicket: 'elv_abc',
      routing: { endpoints: { customer_api: 'https://x.example' } },
    }).toExtend<CreateAssistantSessionInput>();
    expectTypeOf({
      ...BASE_INPUT,
      signInTicket: 'elv_abc',
      context: { page: 'billing' },
    }).not.toExtend<CreateAssistantSessionInput>();
  });
});

describe('AssistantSessionExchangeError', () => {
  const REFUSALS: ReadonlyArray<{ code: string; status: number }> = [
    { code: 'elevation_ticket_invalid', status: 403 },
    { code: 'elevation_ticket_expired', status: 403 },
    { code: 'elevation_tenant_mismatch', status: 403 },
    { code: 'elevation_session_unavailable', status: 409 },
    { code: 'elevation_already_signed_in', status: 409 },
  ];

  it.each(REFUSALS)('types the $code refusal at $status', async ({ code, status }) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'a human sentence', code }, status));

    const failure = await createAssistantSession(
      { ...BASE_INPUT, signInTicket: 'elv_abc' },
      { fetch: fetchMock },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AssistantSessionExchangeError);
    expect(failure).toBeInstanceOf(Error);
    const typed = failure as AssistantSessionExchangeError;
    expect(typed.detail.status).toBe(status);
    expect(typed.detail.serviceCode).toBe(code);
    // A refused exchange must never be retried blind: the ticket is single-use.
    expect(typed.detail.retryable).toBe(false);
    expect(typed.elevationRefusal).toBe(code);
    expect(ASSISTANT_ELEVATION_REFUSAL_CODES).toContain(code);
  });

  it('lets a host tell "visitor took too long" from "client crossed a tenant boundary"', async () => {
    const responses = [
      jsonResponse({ error: 'expired', code: 'elevation_ticket_expired' }, 403),
      jsonResponse({ error: 'mismatch', code: 'elevation_tenant_mismatch' }, 403),
    ];
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(responses.shift() as Response));

    const expired = (await createAssistantSession(
      { ...BASE_INPUT, signInTicket: 'elv_a' },
      { fetch: fetchMock },
    ).catch((error: unknown) => error)) as AssistantSessionExchangeError;
    const mismatch = (await createAssistantSession(
      { ...BASE_INPUT, signInTicket: 'elv_b' },
      { fetch: fetchMock },
    ).catch((error: unknown) => error)) as AssistantSessionExchangeError;

    // Same HTTP status; only the code separates re-prompt from page-someone.
    expect(expired.detail.status).toBe(mismatch.detail.status);
    expect(expired.elevationRefusal).toBe('elevation_ticket_expired');
    expect(mismatch.elevationRefusal).toBe('elevation_tenant_mismatch');
    // The generic-Error contract callers may have string-matched is preserved.
    expect(expired.message).toMatch(/^Assistant session exchange failed \(403\)/);
  });

  it('survives a proxy answering with HTML instead of JSON', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );

    const failure = (await createAssistantSession(BASE_INPUT, { fetch: fetchMock }).catch(
      (error: unknown) => error,
    )) as AssistantSessionExchangeError;

    expect(failure).toBeInstanceOf(AssistantSessionExchangeError);
    expect(failure.detail.status).toBe(502);
    expect(failure.detail.serviceCode).toBeUndefined();
    // An infrastructure 5xx is the one failure worth retrying.
    expect(failure.detail.retryable).toBe(true);
    expect(failure.elevationRefusal).toBeUndefined();
  });

  it('types a fresh-mint refusal too, with the message prefix unchanged', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: 'origin is not allowed' }, 403));

    const failure = (await createAssistantSession(BASE_INPUT, { fetch: fetchMock }).catch(
      (error: unknown) => error,
    )) as AssistantSessionExchangeError;

    expect(failure.detail.status).toBe(403);
    expect(failure.detail.serviceCode).toBeUndefined();
    expect(failure.detail.retryable).toBe(false);
    expect(failure.message).toBe('Assistant session exchange failed (403)');
  });

  it('reports a deployment without elevation as config trouble, not something to retry', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: 'sign-in elevation is not available on this deployment',
          code: 'elevation_unavailable',
        },
        503,
      ),
    );

    const failure = (await createAssistantSession(
      { ...BASE_INPUT, signInTicket: 'elv_abc' },
      { fetch: fetchMock },
    ).catch((error: unknown) => error)) as AssistantSessionExchangeError;

    expect(failure.detail.serviceCode).toBe('elevation_unavailable');
    // 5xx, but retrying cannot help until an operator configures the store.
    expect(failure.detail.retryable).toBe(false);
    expect(failure.elevationRefusal).toBeUndefined();
  });
});

describe('Embedded Assistant v1 wire contract fixture (ADR 0151)', () => {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'contract',
    'v1',
    'assistant-session-response.json',
  );
  const goldenFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as AssistantSession &
    Record<string, unknown>;

  it('pins exactly the fields the widget consumes (drift gate against the service contract)', () => {
    expect(Object.keys(goldenFixture).sort()).toEqual([
      'configuration',
      'endpoints',
      'expiresAt',
      'resume',
      'token',
    ]);
    expect(Object.keys(goldenFixture.endpoints).sort()).toEqual([
      'apps',
      'interactions',
      'sandbox',
      'suggestions',
      'toolConfirmations',
      'transcript',
      'turns',
    ]);
    expect(goldenFixture.endpoints.sandbox).toMatch(/^https:\/\//);
    expect(goldenFixture.endpoints.turns).toMatch(/^https:\/\//);
    expect(goldenFixture.endpoints.toolConfirmations).toMatch(/^https:\/\//);
    expect(goldenFixture.endpoints.interactions).toMatch(/^https:\/\//);
    expect(goldenFixture.endpoints.suggestions).toMatch(/^https:\/\//);
    // The one optional top-level addition: the armed post-sign-in resume hint (issue #1177).
    expect(goldenFixture.resume).toEqual({ tool: 'my_orders' });
  });

  it('drives createAssistantSession end to end', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(goldenFixture), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const session = await createAssistantSession(
      {
        serviceUrl: 'https://cloud.noodleseed.dev',
        clientId: 'embed_123',
        clientSecret: 'server-only-secret',
        origin: 'https://app.example.com',
        user: { id: 'user_123' },
      },
      { fetch: fetchMock },
    );
    expect(session.endpoints.turns).toBe(goldenFixture.endpoints.turns);
    expect(session.endpoints.toolConfirmations).toBe(goldenFixture.endpoints.toolConfirmations);
    expect(session.endpoints.interactions).toBe(goldenFixture.endpoints.interactions);
    expect(session.token).toBe(goldenFixture.token);
  });
});

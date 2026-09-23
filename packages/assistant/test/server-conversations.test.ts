import { describe, expect, it, vi } from 'vitest';
import { AssistantConversationsError, forgetUser, listConversations } from '../src/server.js';

const CREDENTIALS = {
  serviceUrl: 'https://cloud.example/',
  clientId: 'embed_123',
  clientSecret: 'server-only-secret',
} as const;
const ROW = {
  id: 'cv_0123456789abcdef',
  channel: 'website',
  startedAt: '2026-09-07T00:00:00.000Z',
  lastMessageAt: '2026-09-07T00:01:00.000Z',
  preview: 'Where is my parcel?',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function request(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>) {
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  return {
    url,
    method: init?.method,
    headers: init?.headers as Record<string, string>,
    body: JSON.parse(String(init?.body)),
  };
}

describe('listConversations', () => {
  it('lists one verified user with the backend credential and ignores additive fields', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        ok: true,
        data: { conversations: [{ ...ROW, future: 1 }], nextCursor: 'n1', x: 2 },
      }),
    );
    const page = await listConversations(
      { ...CREDENTIALS, user: { id: 'user_7' }, limit: 10, cursor: 'c0' },
      { fetch: fetchMock },
    );
    expect(page).toEqual({ conversations: [ROW], nextCursor: 'n1' });
    const sent = request(fetchMock);
    expect(sent.url).toBe('https://cloud.example/v1/assistant/conversations/list');
    expect(sent.method).toBe('POST');
    expect(sent.headers.Authorization).toBe(
      `Basic ${Buffer.from('embed_123:server-only-secret').toString('base64')}`,
    );
    expect(sent.body).toEqual({ user: { id: 'user_7' }, limit: 10, cursor: 'c0' });
  });

  it('sends only the user id, so session-exchange identity fields never widen the call', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: true, data: { conversations: [] } }));
    const user = { id: 'user_7', email: 'person@example.com', roles: ['admin'] };
    expect(await listConversations({ ...CREDENTIALS, user }, { fetch: fetchMock })).toEqual({
      conversations: [],
    });
    expect(request(fetchMock).body).toEqual({ user: { id: 'user_7' } });
  });

  it('keeps an optional preview absent and rejects a malformed success body', async () => {
    const { preview: _preview, ...bare } = ROW;
    const ok = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: true, data: { conversations: [bare] } }));
    expect(
      (await listConversations({ ...CREDENTIALS, user: { id: 'u' } }, { fetch: ok }))
        .conversations[0],
    ).toEqual(bare);
    const malformed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: true, data: { conversations: [{ id: 5 }] } }));
    const failure = await listConversations(
      { ...CREDENTIALS, user: { id: 'u' } },
      { fetch: malformed },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AssistantConversationsError);
    expect((failure as AssistantConversationsError).detail).toEqual({
      code: 'conversations_response_invalid',
      status: 200,
      retryable: false,
    });
  });
});

describe('forgetUser', () => {
  it('forgets one verified user and returns the erased counts', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ok: true, data: { forgotten: { conversations: 2, items: 5 } } }));
    expect(
      await forgetUser({ ...CREDENTIALS, user: { id: 'user_7' } }, { fetch: fetchMock }),
    ).toEqual({ conversations: 2, items: 5 });
    const sent = request(fetchMock);
    expect(sent.url).toBe('https://cloud.example/v1/assistant/conversations/forget-user');
    expect(sent.body).toEqual({ user: { id: 'user_7' } });
  });

  it.each([
    [401, { error: 'invalid assistant client' }, undefined, false],
    [400, { code: 'conversation_invalid', error: 'Invalid' }, 'conversation_invalid', false],
    [503, { code: 'conversation_unavailable', error: 'x' }, 'conversation_unavailable', true],
    [502, '<html>proxy</html>', undefined, true],
  ] as const)('maps a %i refusal to a typed error', async (status, body, serviceCode, retryable) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        typeof body === 'string' ? new Response(body, { status }) : json(body, status),
      );
    const failure = await forgetUser(
      { ...CREDENTIALS, user: { id: 'user_7' } },
      { fetch: fetchMock },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AssistantConversationsError);
    expect((failure as AssistantConversationsError).detail).toEqual({
      code: 'conversations_request_failed',
      status,
      retryable,
      ...(serviceCode ? { serviceCode } : {}),
    });
    expect(String((failure as Error).message)).not.toContain('server-only-secret');
  });
});

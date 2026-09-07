import { describe, expect, it, vi } from 'vitest';
import { createAssistantClient } from '../src/client.js';
import { NOODLE_CLOUD_URL, resolveSessionSource } from '../src/session-source.js';

/**
 * A public page has no backend to exchange a session through.
 *
 * The authenticated embed's flow — page → its own backend → the service — is what keeps the embed
 * secret out of the browser. A marketing page has neither the backend nor the secret, so it presents a
 * non-secret embed id straight to the service instead. Both are the same access model with a different
 * identity transport (ADR 0201); only the first hop differs.
 */

describe('resolveSessionSource', () => {
  it('sends a public page straight to the service with its embed id', () => {
    expect(resolveSessionSource({ embedId: 'pub_abc' })).toEqual({
      kind: 'public',
      url: `${NOODLE_CLOUD_URL}/v1/assistant/public-sessions`,
      embedId: 'pub_abc',
    });
  });

  it('honours an explicit service origin, so a dev or self-hosted service works', () => {
    expect(
      resolveSessionSource({ embedId: 'pub_abc', serviceUrl: 'http://localhost:8080/' }),
    ).toEqual({
      kind: 'public',
      url: 'http://localhost:8080/v1/assistant/public-sessions',
      embedId: 'pub_abc',
    });
  });

  it('routes an in-app embed through the customer backend, unchanged', () => {
    expect(resolveSessionSource({ sessionEndpoint: '/api/assistant/session' })).toEqual({
      kind: 'exchange',
      url: '/api/assistant/session',
    });
  });

  /**
   * Exclusive, not merged. Silently preferring one would make a copy-paste mistake — an embed id left
   * beside a backend endpoint — pick a transport the developer did not intend.
   */
  it('refuses both at once rather than guessing', () => {
    expect(() =>
      resolveSessionSource({ embedId: 'pub_abc', sessionEndpoint: '/api/assistant/session' }),
    ).toThrow(/either embedId or sessionEndpoint/);
  });

  it('refuses neither', () => {
    expect(() => resolveSessionSource({})).toThrow(/either embedId or sessionEndpoint/);
  });
});

describe('a public client minting its own session', () => {
  function mintResponse(): Response {
    return Response.json({
      token: 'session-token',
      expiresAt: '2030-01-01T00:00:00Z',
      endpoints: {
        turns: 'https://cloud.test/v1/assistant/turns',
        toolConfirmations: 'https://cloud.test/v1/assistant/tool-confirmations',
        interactions: 'https://cloud.test/v1/assistant/interactions',
      },
    });
  }

  it('posts its embed id to the public mint route', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(mintResponse());
    const client = createAssistantClient({
      embedId: 'pub_abc',
      serviceUrl: 'https://cloud.test',
      fetch: fetchMock,
    });

    await client.connect();

    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://cloud.test/v1/assistant/public-sessions');
    expect(body.embedId).toBe('pub_abc');
    // The visitor identifier rides along so admission can be fair per person rather than per source
    // address. It is opaque, non-secret, and the only other thing a public mint sends.
    expect(Object.keys(body).sort()).toEqual(['embedId', 'visitorId']);
    expect(body.visitorId).toMatch(/^[0-9a-f-]{36}$/);
  });

  /**
   * Two reasons, both load-bearing. The mint response carries no `Access-Control-Allow-Credentials`, so
   * a credentialed request would have its response rejected by the browser outright. And a stranger's
   * cookies for our origin have no business travelling with an anonymous mint.
   */
  it('sends no browser credentials with a cross-origin mint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(mintResponse());
    await createAssistantClient({ embedId: 'pub_abc', fetch: fetchMock }).connect();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credentials: 'omit' }),
    );
  });

  it('does not ship page context to a public mint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(mintResponse());
    const client = createAssistantClient({
      embedId: 'pub_abc',
      fetch: fetchMock,
      context: { page: 'pricing' },
    });

    await client.connect();

    // The mint route reads the embed id and the fairness identifier, and nothing else. Page context
    // would be untrusted data sent cross-origin for nothing — it still reaches the model on each
    // turn, where it is actually read.
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(['embedId', 'visitorId']);
    expect(String(init.body)).not.toContain('pricing');
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoodleAssistantElement } from '../src/index.js';

/**
 * The public mount, end to end through the element.
 *
 * This is the whole one-line experience: a marketing page carries one tag with a non-secret id, and the
 * element mints its own anonymous session. Attribute-driven because the script-tag snippet has no
 * JavaScript of its own to set properties with.
 */

function stubFetch(): ReturnType<typeof vi.fn<typeof fetch>> {
  const mock = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      token: 'session-token',
      expiresAt: '2030-01-01T00:00:00Z',
      endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
    }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

const sessionResponse = () =>
  Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
  });

function markdownResponse(url: string, content: string): Response {
  const response = new Response(content, {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function turnResponse(): Response {
  return new Response('event: done\ndata: {}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function responseAt(url: string, response: Response): Response {
  if (response.url === '') Object.defineProperty(response, 'url', { value: url });
  return response;
}

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the element mounted by embed id', () => {
  it('mints from the service when given only an embed-id attribute', async () => {
    const fetchMock = stubFetch();
    const element = new NoodleAssistantElement();
    element.setAttribute('embed-id', 'pub_abc');
    element.setAttribute('service-url', 'https://cloud.test');
    document.body.append(element);
    // A public embed mints on first open, not on mount: a page view is not a conversation.
    element.open();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const mint = fetchMock.mock.calls.find(
      ([input]) => input === 'https://cloud.test/v1/assistant/public-sessions',
    );
    expect(mint).toBeDefined();
    const body = JSON.parse(String((mint?.[1] as RequestInit).body));
    expect(body.embedId).toBe('pub_abc');
    expect(Object.keys(body).sort()).toEqual(['embedId', 'visitorId']);
  });

  it('starts public first-open work when the open attribute is present at connection', async () => {
    const pageUrl = `${location.origin}/declarative-open`;
    history.replaceState({}, '', '/declarative-open');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) return markdownResponse(pageUrl, '# Declarative open');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.setAttribute('embed-id', 'pub_abc');
    element.setAttribute('service-url', 'https://cloud.test');
    element.setAttribute('open', '');

    document.body.append(element);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(pageUrl, expect.anything());
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cloud.test/v1/assistant/public-sessions',
        expect.anything(),
      );
    });
  });

  it('stays inert with neither an endpoint nor an embed id', () => {
    const fetchMock = stubFetch();
    document.body.append(new NoodleAssistantElement());

    // A tag pasted without its id must not fire a request it cannot possibly authorize.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the in-app backend exchange untouched', async () => {
    const fetchMock = stubFetch();
    const element = new NoodleAssistantElement();
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/assistant/session');
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).credentials).toBe('same-origin');
  });

  it('attaches the canonical current-page Markdown snapshot to a public turn', async () => {
    history.replaceState({}, '', '/pricing?campaign=summer#plans');
    const pageUrl = `${location.origin}/pricing`;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) return markdownResponse(pageUrl, '# Pricing');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('What does this cost?');

    expect(fetchMock).toHaveBeenCalledWith(
      pageUrl,
      expect.objectContaining({
        headers: { Accept: 'text/markdown' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      }),
    );
    const turn = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(turn).toMatchObject({
      message: 'What does this cost?',
      pageContext: {
        page: { url: pageUrl, contentType: 'text/markdown', content: '# Pricing' },
      },
    });
  });

  it('replaces a public snapshot on an SPA path change without retaining stale content', async () => {
    const firstUrl = `${location.origin}/first`;
    const secondUrl = `${location.origin}/second`;
    history.replaceState({}, '', '/first');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === firstUrl) return markdownResponse(firstUrl, '# First');
      if (input === secondUrl) return markdownResponse(secondUrl, '# Second');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('First page');
    history.replaceState({}, '', '/second?from=first#details');
    await element.sendMessage('Second page');

    const turns = fetchMock.mock.calls
      .filter(([input]) => input === '/turns')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(turns).toMatchObject([
      {
        message: 'First page',
        pageContext: { page: { url: firstUrl, contentType: 'text/markdown', content: '# First' } },
      },
      {
        message: 'Second page',
        pageContext: {
          page: { url: secondUrl, contentType: 'text/markdown', content: '# Second' },
        },
      },
    ]);
  });

  it('replaces an old snapshot with URL-only context when a new SPA page cannot be fetched', async () => {
    const firstUrl = `${location.origin}/available`;
    const failedUrl = `${location.origin}/unavailable`;
    history.replaceState({}, '', '/available');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === firstUrl) return markdownResponse(firstUrl, '# Available');
      if (input === failedUrl) throw new TypeError('Network unavailable');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('First page');
    history.replaceState({}, '', '/unavailable');
    await element.sendMessage('Unavailable page');

    const turns = fetchMock.mock.calls
      .filter(([input]) => input === '/turns')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(turns[1]?.pageContext).toEqual({ page: { url: failedUrl } });
  });

  it('uses URL-only context when Markdown content is credential-shaped', async () => {
    const pageUrl = `${location.origin}/private`;
    history.replaceState({}, '', '/private');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl)
        return markdownResponse(pageUrl, 'bearer abcdefghijklmnopqrstuvwxyz123456');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('Summarize this');

    const turn = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(turn.pageContext).toEqual({ page: { url: pageUrl } });
  });

  it('omits unsafe automatic context without fetching or blocking subsequent turns', async () => {
    const credentialPath = '/aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb.cccccccccccccccccc';
    const pageUrl = `${location.origin}${credentialPath}`;
    history.replaceState({}, '', credentialPath);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) throw new Error('Unsafe page URL must not be fetched');
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('First safe turn');
    await element.sendMessage('Second safe turn');

    expect(fetchMock.mock.calls.filter(([input]) => input === pageUrl)).toHaveLength(0);
    const turns = fetchMock.mock.calls
      .filter(([input]) => input === '/turns')
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(turns).toHaveLength(2);
    expect(turns.every((turn) => !Object.hasOwn(turn, 'pageContext'))).toBe(true);
  });

  it.each([
    ['an unsuccessful status', () => new Response('# Unavailable', { status: 503 })],
    ['a cross-origin response', () => markdownResponse('https://other.test/private', '# Other')],
    [
      'a non-Markdown MIME type',
      () => new Response('<h1>HTML</h1>', { headers: { 'content-type': 'text/html' } }),
    ],
    [
      'invalid UTF-8',
      () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { 'content-type': 'text/markdown' },
        }),
    ],
  ])('uses URL-only context for %s', async (_description, responseFactory) => {
    const pageUrl = `${location.origin}/validation`;
    history.replaceState({}, '', '/validation');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) return responseAt(pageUrl, responseFactory());
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('Is this page available?');

    const turn = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(turn.pageContext).toEqual({ page: { url: pageUrl } });
  });

  it('bounds valid Markdown at 12 KiB and marks a truncated snapshot', async () => {
    const pageUrl = `${location.origin}/long`;
    history.replaceState({}, '', '/long');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) return markdownResponse(pageUrl, `${'a'.repeat(12 * 1024)} trailing`);
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    await element.sendMessage('Summarize this page');

    const turn = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(turn.pageContext).toEqual({
      page: {
        url: pageUrl,
        contentType: 'text/markdown',
        content: 'a'.repeat(12 * 1024),
        truncated: true,
      },
    });
  });

  it('falls back to URL-only context after the two-second Markdown timeout', async () => {
    vi.useFakeTimers();
    const pageUrl = `${location.origin}/slow`;
    history.replaceState({}, '', '/slow');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      if (input === pageUrl) {
        return new Promise<Response>((_resolve, reject) => {
          (init?.signal as AbortSignal).addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      if (input === 'https://cloud.test/v1/assistant/public-sessions')
        return Promise.resolve(sessionResponse());
      return Promise.resolve(turnResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();
    const turn = element.sendMessage('Summarize this page');
    await vi.advanceTimersByTimeAsync(2_000);
    await turn;

    const request = fetchMock.mock.calls.find(([input]) => input === pageUrl)?.[1] as RequestInit;
    expect(request.signal?.aborted).toBe(true);
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.pageContext).toEqual({ page: { url: pageUrl } });
    vi.useRealTimers();
  });

  it('lets explicit page context override automatic public fetching', async () => {
    const pageUrl = `${location.origin}/override`;
    history.replaceState({}, '', '/override');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === 'https://cloud.test/v1/assistant/public-sessions') return sessionResponse();
      return turnResponse();
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_abc';
    element.serviceUrl = 'https://cloud.test';
    element.updatePageContext({ productId: 'pro' });
    document.body.append(element);

    element.open();
    await element.sendMessage('Tell me about Pro');

    expect(fetchMock).not.toHaveBeenCalledWith(pageUrl, expect.anything());
    const turn = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(turn.pageContext).toEqual({ productId: 'pro' });
  });
});

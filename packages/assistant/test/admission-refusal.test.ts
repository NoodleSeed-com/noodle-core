// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantClientError, createAssistantClient } from '../src/client.js';
import { NoodleAssistantElement } from '../src/index.js';

/**
 * What a visitor sees when a public surface is spent or switched off.
 *
 * A daily budget is a capacity decision, not a fault: it must read calmly and — more importantly — it
 * must not offer a retry. Every open tab reconnecting against a switched-off surface is precisely the
 * load admission exists to refuse, so the affordance has to disappear, not just the alarming words.
 */

const CAP_REACHED = () =>
  Response.json(
    { error: 'assistant is unavailable right now', code: 'daily_session_budget_exhausted' },
    { status: 429 },
  );

const SESSION_SPENT = () =>
  Response.json(
    {
      error: 'this conversation has reached its length limit',
      code: 'session_turn_budget_exhausted',
    },
    { status: 429 },
  );

const MINTED = () =>
  Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: { turns: 'https://cloud.test/v1/assistant/turns', toolConfirmations: '/c' },
  });

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the client surfaces the service’s refusal code', () => {
  it('carries the mint refusal through instead of flattening it to session_failed', async () => {
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: vi.fn(CAP_REACHED) });

    // The generic code stays for consumers switching on it (a published closed union); the specific
    // reason arrives beside it.
    await expect(client.connect()).rejects.toMatchObject({
      detail: { code: 'session_failed', serviceCode: 'daily_session_budget_exhausted' },
    });
  });

  it('marks an exhausted daily budget as not retryable', async () => {
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: vi.fn(CAP_REACHED) });

    // A session failure is retryable by default; a surface with nothing left to spend is not.
    await expect(client.connect()).rejects.toMatchObject({ detail: { retryable: false } });
  });

  it('leaves an ordinary session failure retryable', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: fetchMock });

    await expect(client.connect()).rejects.toMatchObject({
      detail: { code: 'session_failed', retryable: true },
    });
  });

  it('survives a refusal body that is not JSON', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('<html>gateway</html>', { status: 502 }));
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: fetchMock });

    const error = await client.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantClientError);
    expect((error as AssistantClientError).detail.serviceCode).toBeUndefined();
  });

  it('carries a turn refusal through too', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(MINTED())
      .mockResolvedValueOnce(SESSION_SPENT());
    const client = createAssistantClient({ embedId: 'pub_abc', fetch: fetchMock });
    await client.connect();

    await expect(client.sendMessage('hello')).rejects.toMatchObject({
      detail: { code: 'turn_failed', serviceCode: 'session_turn_budget_exhausted' },
    });
  });
});

describe('the widget renders a spent surface calmly', () => {
  async function mount(response: () => Response) {
    vi.stubGlobal('fetch', vi.fn(response));
    const element = new NoodleAssistantElement();
    element.setAttribute('embed-id', 'pub_abc');
    element.setAttribute('service-url', 'https://cloud.test');
    document.body.append(element);
    // The refusal is only reachable once the visitor opens it, because that is when a public embed
    // mints — a page view no longer spends the surface's budget.
    element.open();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector('.conversation-error')).toBeTruthy(),
    );
    return element.shadowRoot?.querySelector('.conversation-error') as HTMLElement;
  }

  it('offers no retry when the surface has nothing left to spend', async () => {
    const card = await mount(CAP_REACHED);

    expect(card.textContent).toBeTruthy();
    // The whole point: a reconnect button here turns every open tab into the retry storm the daily
    // cap was set to stop.
    expect(card.querySelector('button')).toBeNull();
  });

  it('keeps the retry when reconnecting would actually help', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.setAttribute('embed-id', 'pub_abc');
    element.setAttribute('service-url', 'https://cloud.test');
    document.body.append(element);
    // The refusal is only reachable once the visitor opens it, because that is when a public embed
    // mints — a page view no longer spends the surface's budget.
    element.open();
    await vi.waitFor(() =>
      expect(element.shadowRoot?.querySelector('.conversation-error')).toBeTruthy(),
    );

    const card = element.shadowRoot?.querySelector('.conversation-error') as HTMLElement;
    expect(card.querySelector('button')).toBeTruthy();
  });

  it('offers a fresh conversation when this session has spent its forty turns', async () => {
    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = String(input);
      if (url.includes('/v1/assistant/public-configurations/')) {
        return Promise.resolve(Response.json({ configuration: {} }));
      }
      if (url.endsWith('/v1/assistant/public-sessions')) {
        return Promise.resolve(MINTED());
      }
      return Promise.resolve(SESSION_SPENT());
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.setAttribute('embed-id', 'pub_abc');
    element.setAttribute('service-url', 'https://cloud.test');
    element.updatePageContext({ test: true });
    document.body.append(element);
    element.open();
    await vi.waitFor(() => expect(element.dataset.sessionState).toBe('ready'));

    await element.sendMessage('One more question').catch(() => undefined);
    const card = element.shadowRoot?.querySelector('.conversation-error') as HTMLElement;
    const action = card.querySelector('button');
    expect(action?.textContent).toBe('New conversation');
    action?.click();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(element.shadowRoot?.querySelector('.conversation-error')).toBeNull();
    expect(element.hasAttribute('has-messages')).toBe(false);
  });
});

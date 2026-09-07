// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NoodleAssistantElement } from '../src/index.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

/**
 * A mint must mean a conversation.
 *
 * The widget used to open a session in `connectedCallback`, so every page view spent one — and the
 * pilot's surface went dark after 300 mints against 38 turns, its whole day consumed by people who
 * never opened the assistant. The operator's "mints/day" is supposed to count conversations, and the
 * per-address hourly ceiling is sized for them too, so both numbers meant the wrong thing.
 */

const sessionResponse = () =>
  Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
  });

const brandedSessionResponse = () =>
  Response.json({
    token: 'session-token',
    expiresAt: '2030-01-01T00:00:00Z',
    endpoints: { turns: '/turns', toolConfirmations: '/confirmations' },
    configuration: {
      branding: { name: 'Acme Store', accent: '#008060' },
      assistant: { labels: { welcomeHeading: 'How can I help you shop?' } },
    },
  });

function mount(): { element: NoodleAssistantElement; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sessionResponse());
  vi.stubGlobal('fetch', fetchMock);
  const element = new NoodleAssistantElement();
  element.embedId = 'pub_0000000000000000000000000';
  element.serviceUrl = 'https://cloud.test';
  document.body.append(element);
  return { element, fetchMock };
}

describe('the widget mints lazily', () => {
  it('opens no session merely because a page rendered', () => {
    const { element, fetchMock } = mount();

    // A visitor who never opens the assistant costs the surface nothing.
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/v1/assistant/public-sessions'),
      ),
    ).toHaveLength(0);
    // The launcher is still there and usable — nothing about the page changed.
    expect(element.shadowRoot?.querySelector('.launcher')).toBeTruthy();
  });

  it('loads public appearance without minting so the closed launcher matches the live settings', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('/v1/assistant/public-configurations/')) {
        return Promise.resolve(
          Response.json({
            configuration: {
              branding: {
                name: 'Acme Store',
                logo: { uri: 'https://assets.test/acme.png', alt: 'Acme' },
              },
              assistant: {
                theme: 'dark',
                layout: { position: 'bottom-right' },
                presentation: { launcher: { style: 'bubble' } },
              },
            },
            fallback: 'halo',
            revision: 3,
          }),
        );
      }
      return Promise.resolve(sessionResponse());
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_0000000000000000000000000';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    expect(element.hasAttribute('data-public-configuration-loading')).toBe(true);
    expect(element.hasAttribute('data-presentation-ready')).toBe(false);

    await vi.waitFor(() => {
      expect(element.dataset.position).toBe('bottom-right');
      expect(element.dataset.launcherStyle).toBe('bubble');
      expect(element.getAttribute('aria-label')).toBe('Acme Store');
      expect(element.shadowRoot?.querySelector<HTMLImageElement>('.launcher-glyph')?.src).toBe(
        'https://assets.test/acme.png',
      );
      expect(element.hasAttribute('data-public-configuration-loading')).toBe(false);
      expect(element.hasAttribute('data-presentation-ready')).toBe(true);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.test/v1/assistant/public-configurations/pub_0000000000000000000000000',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith('/v1/assistant/public-sessions'),
      ),
    ).toHaveLength(0);
  });

  it('opens exactly one session when the visitor opens it, however many times they do', async () => {
    const { element, fetchMock } = mount();

    element.open();
    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cloud.test/v1/assistant/public-sessions',
        expect.anything(),
      ),
    );

    // Closing and reopening is the same conversation, not a second one.
    element.close();
    element.open();
    element.close();
    element.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => input === 'https://cloud.test/v1/assistant/public-sessions',
      ),
    ).toHaveLength(1);
  });

  it('does not expose the open panel until session branding is applied', async () => {
    let resolveSession: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (String(input).includes('/v1/assistant/public-configurations/')) {
        return Promise.resolve(Response.json({ configuration: {} }));
      }
      return new Promise<Response>((resolve) => {
        resolveSession = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_0000000000000000000000000';
    element.serviceUrl = 'https://cloud.test';
    document.body.append(element);

    element.open();

    expect(element.hasAttribute('open')).toBe(true);
    expect(element.hasAttribute('data-presentation-ready')).toBe(false);
    expect(element.shadowRoot?.querySelector('header strong')?.textContent).toBe('Assistant');

    await vi.waitFor(() => expect(resolveSession).toBeDefined());
    resolveSession?.(brandedSessionResponse());

    await vi.waitFor(() => {
      expect(element.hasAttribute('data-presentation-ready')).toBe(true);
      expect(element.shadowRoot?.querySelector('header strong')?.textContent).toBe('Acme Store');
    });
  });

  it('primes at mount only when the host declares start-open', async () => {
    // An assistant that starts open is one conversation per page view by definition, so it keeps its
    // eager session. It has to be declared on the element: the authored appearance arrives *with* a
    // session, so reading it here would need the very mint this change avoids.
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(sessionResponse());
    vi.stubGlobal('fetch', fetchMock);
    const element = new NoodleAssistantElement();
    element.embedId = 'pub_0000000000000000000000000';
    element.serviceUrl = 'https://cloud.test';
    element.setAttribute('start-open', '');
    document.body.append(element);

    await vi.waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cloud.test/v1/assistant/public-sessions',
        expect.anything(),
      ),
    );
    expect(element.hasAttribute('open')).toBe(true);
  });
});

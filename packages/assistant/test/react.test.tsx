// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoodleAssistantElement, registerNoodleAssistant } from '../src/element.js';
import { NoodleAssistant } from '../src/react.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

beforeEach(() => {
  // Happy DOM does not run class private-field initialization when upgrading an already-connected
  // unknown custom element. Register first; real browsers support both this path and late upgrade.
  registerNoodleAssistant();
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  history.replaceState({}, '', '/');
});

describe('React assistant wrapper', () => {
  it('configures the canonical custom element instead of maintaining a second renderer', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onReady = vi.fn();
    await act(async () => {
      root.render(
        <NoodleAssistant
          sessionEndpoint="/api/assistant/session"
          theme="dark"
          open
          onReady={onReady}
        />,
      );
    });
    const element = host.querySelector('noodle-assistant');
    expect(element?.getAttribute('session-endpoint')).toBe('/api/assistant/session');
    expect(element?.getAttribute('theme')).toBe('dark');
    expect(element?.hasAttribute('open')).toBe(true);
    expect(element?.shadowRoot?.textContent).toContain('Assistant');
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    const replacementReady = vi.fn();
    await act(async () => {
      root.render(
        <NoodleAssistant
          sessionEndpoint="/api/assistant/session"
          theme="light"
          onReady={replacementReady}
        />,
      );
    });
    expect(onReady).toHaveBeenCalledOnce();
    expect(replacementReady).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('keeps typed page and model context in parity with the custom element', async () => {
    const page = vi.spyOn(NoodleAssistantElement.prototype, 'updatePageContext');
    const model = vi.spyOn(NoodleAssistantElement.prototype, 'updateModelContext');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NoodleAssistant<{ selectedAccountId: string }>
          sessionEndpoint="/api/assistant/session"
          pageContext={{ selectedAccountId: 'account-1' }}
          modelContext={{ structuredContent: { state: 'ready' } }}
        />,
      );
    });
    expect(page).toHaveBeenCalledWith({ selectedAccountId: 'account-1' });
    expect(model).toHaveBeenCalledWith({ structuredContent: { state: 'ready' } });
    await act(async () => root.unmount());
  });

  it.each([
    ['authenticated', { sessionEndpoint: '/api/assistant/session' }],
    ['public', { embedId: 'pub_abc', serviceUrl: 'https://cloud.test' }],
  ] as const)('honors hidden confirmation details through the %s React mount', async (_source, sourceProps) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://cloud.test/v1/assistant/public-configurations/pub_abc') {
        return Response.json({
          configuration: {
            assistant: { behavior: { showConfirmationDetails: false } },
          },
        });
      }
      if (
        url === '/api/assistant/session' ||
        url === 'https://cloud.test/v1/assistant/public-sessions'
      ) {
        return Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            interactions: 'https://cloud.example/v1/assistant/interactions',
          },
          configuration: {
            assistant: { behavior: { showConfirmationDetails: false } },
          },
        });
      }
      if (url === 'https://cloud.example/v1/assistant/turns') {
        return new Response(
          'event: tool_proposed\ndata: {"id":"confirm_1","tool":"complete_task","title":"Complete task","arguments":{"taskId":"task_123","action":{"connector":"tasks@1.0","operation":"complete"}}}\n\nevent: done\ndata: {}\n\n',
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<NoodleAssistant {...sourceProps} pageContext={{ page: 'checkout' }} />);
    });
    const element = host.querySelector('noodle-assistant') as NoodleAssistantElement;
    await act(async () => element.sendMessage('Complete the task'));

    expect(element.shadowRoot?.textContent).toContain('Complete task');
    expect(element.shadowRoot?.textContent).toContain('task_123');
    expect(element.shadowRoot?.textContent).not.toContain('Additional details');
    expect(element.shadowRoot?.textContent).not.toContain('tasks@1.0');
    expect(element.shadowRoot?.querySelector('.proposal-details')).toBeNull();
    await act(async () => root.unmount());
  });

  it('loads public appearance at mount and starts page/session work when controlled open changes', async () => {
    const pageUrl = `${location.origin}/react-open`;
    history.replaceState({}, '', '/react-open');
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === pageUrl) {
        const response = new Response('# React open', {
          headers: { 'content-type': 'text/markdown; charset=utf-8' },
        });
        Object.defineProperty(response, 'url', { value: pageUrl });
        return response;
      }
      return Response.json({
        token: 'session-token',
        expiresAt: '2030-01-01T00:00:00Z',
        endpoints: {
          turns: 'https://cloud.example/v1/assistant/turns',
          toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <NoodleAssistant embedId="pub_abc" serviceUrl="https://cloud.test" open={false} />,
      );
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://cloud.test/v1/assistant/public-configurations/pub_abc',
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(pageUrl, expect.anything());
    expect(fetchMock).not.toHaveBeenCalledWith(
      'https://cloud.test/v1/assistant/public-sessions',
      expect.anything(),
    );

    await act(async () => {
      root.render(<NoodleAssistant embedId="pub_abc" serviceUrl="https://cloud.test" open />);
    });
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(pageUrl, expect.anything());
      expect(fetchMock).toHaveBeenCalledWith(
        'https://cloud.test/v1/assistant/public-sessions',
        expect.anything(),
      );
    });
    await act(async () => root.unmount());
  });

  it('fires onReady once when the element was defined and upgraded before the wrapper mounted', async () => {
    // The canonical embed entry (or an earlier <NoodleAssistant>) may have registered the element
    // long before this component's effect runs; readiness is sticky via the shadowRoot fallback.
    // (The suite's beforeEach registers first, so this pins the pre-defined path explicitly.)
    const early = new NoodleAssistantElement();
    document.body.append(early);
    expect(early.shadowRoot).toBeTruthy();
    early.remove();

    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onReady = vi.fn();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await act(async () => {
      root.render(<NoodleAssistant sessionEndpoint="/api/assistant/session" onReady={onReady} />);
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    // The readiness breadcrumb is the one observable trace of this path.
    expect(debug).toHaveBeenCalledWith('[noodle-assistant] ready');
    await act(async () => root.unmount());
  });

  it('fires onReady exactly once under React Strict Mode double-invoked effects', async () => {
    const { StrictMode } = await import('react');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onReady = vi.fn();
    await act(async () => {
      root.render(
        <StrictMode>
          <NoodleAssistant sessionEndpoint="/api/assistant/session" onReady={onReady} />
        </StrictMode>,
      );
    });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
    await Promise.resolve();
    expect(onReady).toHaveBeenCalledOnce();
    await act(async () => root.unmount());
  });
});

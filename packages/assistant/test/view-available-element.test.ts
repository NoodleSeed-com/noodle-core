// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_RENDER_TIMEOUT_MS,
  createAssistantAppHostContext,
  isAllowedAppLink,
} from '../src/app-host.js';
import type { AssistantViewAvailableDetail } from '../src/client.js';
import {
  ASSISTANT_TAG_NAME,
  type NoodleAssistantElement,
  registerNoodleAssistant,
} from '../src/element.js';

window.happyDOM.settings.disableIframePageLoading = true;

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('standard assistant view availability', () => {
  it('passes theme and explicit display-mode policy into MCP App host context', () => {
    expect(createAssistantAppHostContext('dark')).toMatchObject({
      theme: 'dark',
      displayMode: 'inline',
      availableDisplayModes: ['inline'],
      platform: 'web',
    });
    expect(createAssistantAppHostContext('dark', true).availableDisplayModes).toEqual([
      'inline',
      'fullscreen',
    ]);
    expect(createAssistantAppHostContext('dark', true, 'fullscreen').displayMode).toBe(
      'fullscreen',
    );
    expect(createAssistantAppHostContext('dark', false, 'fullscreen').displayMode).toBe('inline');
  });

  it('allows app links only to an explicitly declared HTTPS handoff origin', () => {
    expect(
      isAllowedAppLink(
        'https://orders.example.com/checkout/123',
        ['https://orders.example.com'],
        'https://app.example.com/orders',
      ),
    ).toBe('https://orders.example.com/checkout/123');
    expect(
      isAllowedAppLink(
        'https://evil.example/checkout/123',
        ['https://orders.example.com'],
        'https://app.example.com/orders',
      ),
    ).toBeUndefined();
    expect(isAllowedAppLink('/account', [], 'https://app.example.com/orders')).toBeUndefined();
  });

  it('dispatches a typed DOM event without fetching or claiming to render ui:// content', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          'event: view_available\ndata: {"id":"call_1","tool":"open_order","resourceUri":"ui://orders/order_card","title":"Order","result":{"orderId":"order_1"}}\n\nevent: done\ndata: {}\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const available: AssistantViewAvailableDetail[] = [];
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    element.addEventListener('assistant-view-available', (event) => available.push(event.detail));
    document.body.append(element);

    await element.sendMessage('Open my order');

    expect(available).toEqual([
      expect.objectContaining({
        tool: 'open_order',
        resourceUri: 'ui://orders/order_card',
        result: { orderId: 'order_1' },
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(element.shadowRoot?.querySelector('iframe')).toBeNull();
    expect(element.shadowRoot?.textContent).not.toContain('ui://orders/order_card');
  });

  it('mounts a self-contained MCP App behind a sandbox proxy when the service supplies HTML', async () => {
    const html = '<!doctype html><html><body><p>Order app</p></body></html>';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            apps: 'https://cloud.example/v1/assistant/apps',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `event: view_available\ndata: ${JSON.stringify({ id: 'call_1', tool: 'open_order', resourceUri: 'ui://orders/order_card', title: 'Order', result: { orderId: 'order_1' }, arguments: {}, html })}\n\nevent: done\ndata: {}\n\n`,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    document.body.append(element);

    await element.sendMessage('Open my order');

    const frame = element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.srcdoc).toContain('sandbox-proxy-ready');
  });

  it('loads the hosted sandbox document by src when the session advertises one', async () => {
    vi.useFakeTimers();
    const html = '<!doctype html><html><body><p>Order app</p></body></html>';
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          token: 'session-token',
          expiresAt: '2030-01-01T00:00:00Z',
          endpoints: {
            turns: 'https://cloud.example/v1/assistant/turns',
            toolConfirmations: 'https://cloud.example/v1/assistant/tool-confirmations',
            apps: 'https://cloud.example/v1/assistant/apps',
            sandbox: 'https://cloud.example/v1/assistant/sandbox',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          `event: view_available\ndata: ${JSON.stringify({ id: 'call_1', tool: 'open_order', resourceUri: 'ui://orders/order_card', title: 'Order', result: { orderId: 'order_1' }, arguments: {}, html })}\n\nevent: done\ndata: {}\n\n`,
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    registerNoodleAssistant();
    const element = document.createElement(ASSISTANT_TAG_NAME) as NoodleAssistantElement;
    element.sessionEndpoint = '/api/assistant/session';
    const errors: Array<{ code: string; retryable: boolean }> = [];
    element.addEventListener('assistant-error', (event) => errors.push(event.detail));
    document.body.append(element);

    await element.sendMessage('Open my order');

    const frame = element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame');
    expect(frame).not.toBeNull();
    expect(frame?.getAttribute('src')).toBe('https://cloud.example/v1/assistant/sandbox');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.srcdoc ?? '').toBe('');

    vi.advanceTimersByTime(APP_RENDER_TIMEOUT_MS + 1);
    expect(element.shadowRoot?.querySelector('iframe')).toBeNull();
    expect(element.shadowRoot?.querySelector('.noodle-app-fallback')?.textContent).toContain(
      'could not be displayed',
    );
    expect(errors).toEqual([{ code: 'view_render_timeout', retryable: false }]);
  });
});

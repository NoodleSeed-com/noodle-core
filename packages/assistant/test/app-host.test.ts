// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_RENDER_TIMEOUT_MS,
  type AssistantAppHostActions,
  MAX_INLINE_APP_HEIGHT,
  mountAssistantApp,
  PROXY_DOCUMENT,
  unmountAssistantApp,
} from '../src/app-host.js';
import type { AssistantClient } from '../src/client.js';

const actions: AssistantAppHostActions = {
  client: { requestApp: async () => ({}) } as unknown as AssistantClient,
  sendMessage: async () => {},
  updateModelContext: () => {},
};

const detail = {
  id: 'call_1',
  tool: 'open_order',
  resourceUri: 'ui://orders/order_card',
  title: 'Order',
  result: { orderId: 'order_1' },
  html: '<!doctype html><html><body><p>Order app</p></body></html>',
};

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('mountAssistantApp sandbox host', () => {
  it('pins the srcdoc fallback document to the hosted sandbox contract fixture', () => {
    const fixture = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'contract',
        'v1',
        'assistant-sandbox-document.html',
      ),
      'utf8',
    );
    expect(PROXY_DOCUMENT).toBe(fixture.trimEnd());
  });

  it('falls back to the srcdoc proxy when the sandbox URL is absent or not http(s)', () => {
    for (const sandboxUrl of [undefined, 'javascript:alert(1)', 'not a url', 'data:text/html,x']) {
      const card = mountAssistantApp(detail, actions, sandboxUrl ? { sandboxUrl } : {});
      const frame = card?.querySelector('iframe');
      expect(frame?.getAttribute('src')).toBeNull();
      expect(frame?.srcdoc).toContain('sandbox-proxy-ready');
    }
  });

  it('replaces a widget that never completes its bridge handshake with a visible fallback', () => {
    vi.useFakeTimers();
    const failures: { code: string; retryable: boolean }[] = [];
    const card = mountAssistantApp(detail, actions, {
      sandboxUrl: 'https://cloud.example/v1/assistant/sandbox',
      onRenderFailure: (failure) => failures.push(failure),
    });
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    expect(card.querySelector('iframe')).not.toBeNull();

    vi.advanceTimersByTime(APP_RENDER_TIMEOUT_MS + 1);

    expect(card.querySelector('iframe')).toBeNull();
    expect(card.querySelector('.noodle-app-fallback')?.textContent).toContain(
      'could not be displayed',
    );
    expect(failures).toEqual([{ code: 'view_render_timeout', retryable: false }]);
  });

  it('lets a conforming inline App own its full reported height without an inner scrollbar', async () => {
    const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
    let bridge: AppBridge | undefined;
    vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
      bridge = this;
      this.oninitialized?.({});
    });
    const card = mountAssistantApp(detail, actions);
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    const frame = card.querySelector<HTMLIFrameElement>('iframe');
    frame?.dispatchEvent(new Event('load'));

    bridge?.onsizechange?.({ height: 1_640, width: 320 });
    expect(frame?.style.height).toBe('1640px');
    expect(frame?.getAttribute('scrolling')).toBe('no');

    bridge?.onsizechange?.({ height: MAX_INLINE_APP_HEIGHT + 1, width: 320 });
    expect(frame?.style.height).toBe(`${MAX_INLINE_APP_HEIGHT}px`);
  });

  it('keeps App-requested fullscreen inline unless the embedding host opts in', async () => {
    const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
    let bridge: AppBridge | undefined;
    vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
      bridge = this;
      this.oninitialized?.({});
    });
    const card = mountAssistantApp(detail, actions);
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    card.querySelector('iframe')?.dispatchEvent(new Event('load'));
    const exitFullscreen = card.querySelector<HTMLButtonElement>('.noodle-app-fullscreen-exit');

    expect(exitFullscreen?.getAttribute('aria-label')).toBe('Exit fullscreen');
    expect(exitFullscreen?.hidden).toBe(true);

    await expect(bridge?.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({
      mode: 'inline',
    });
    expect(card.hasAttribute('data-fullscreen')).toBe(false);
    expect(exitFullscreen?.hidden).toBe(true);
  });

  it('exposes a host-owned exit that returns an opted-in App to inline without teardown', async () => {
    const { AppBridge } = await import('@modelcontextprotocol/ext-apps/app-bridge');
    let bridge: AppBridge | undefined;
    vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
    const teardown = vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
    vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
      bridge = this;
      this.oninitialized?.({});
    });
    const card = mountAssistantApp(detail, actions, { allowFullscreen: true });
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    const mountedFrame = card.querySelector('iframe');
    mountedFrame?.dispatchEvent(new Event('load'));
    const sendHostContextChange = vi
      .spyOn(AppBridge.prototype, 'sendHostContextChange')
      .mockResolvedValue();
    const exitFullscreen = card.querySelector<HTMLButtonElement>('.noodle-app-fullscreen-exit');

    expect(exitFullscreen?.hidden).toBe(true);

    await expect(bridge?.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({
      mode: 'fullscreen',
    });
    expect(card.hasAttribute('data-fullscreen')).toBe(true);
    expect(exitFullscreen?.hidden).toBe(false);
    expect(sendHostContextChange).toHaveBeenLastCalledWith({ displayMode: 'fullscreen' });

    exitFullscreen?.click();

    expect(card.hasAttribute('data-fullscreen')).toBe(false);
    expect(exitFullscreen?.hidden).toBe(true);
    expect(card.querySelector('iframe')).toBe(mountedFrame);
    expect(teardown).not.toHaveBeenCalled();
    expect(sendHostContextChange).toHaveBeenLastCalledWith({ displayMode: 'inline' });
  });

  it('tears down an initialized App bridge once before removing its frame', async () => {
    const { AppBridge, PostMessageTransport } = await import(
      '@modelcontextprotocol/ext-apps/app-bridge'
    );
    const teardown = vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
    const close = vi.spyOn(PostMessageTransport.prototype, 'close').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
      this.oninitialized?.({});
    });
    const card = mountAssistantApp(detail, actions);
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    card.querySelector('iframe')?.dispatchEvent(new Event('load'));

    const first = unmountAssistantApp(card);
    const second = unmountAssistantApp(card);
    await Promise.all([first, second]);

    expect(teardown).toHaveBeenCalledOnce();
    expect(teardown).toHaveBeenCalledWith({}, { timeout: 1_000 });
    expect(close).toHaveBeenCalledOnce();
    expect(card.isConnected).toBe(false);
  });

  it('rejects App effects once teardown begins', async () => {
    const { AppBridge, PostMessageTransport } = await import(
      '@modelcontextprotocol/ext-apps/app-bridge'
    );
    let finishTeardown: (() => void) | undefined;
    vi.spyOn(AppBridge.prototype, 'teardownResource').mockImplementation(
      () =>
        new Promise((resolve) => {
          finishTeardown = () => resolve({});
        }),
    );
    vi.spyOn(PostMessageTransport.prototype, 'close').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
    vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
    let bridge: AppBridge | undefined;
    vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
      bridge = this;
      this.oninitialized?.({});
    });
    const requestApp = vi.fn(async () => ({}));
    const sendMessage = vi.fn(async () => {});
    const updateModelContext = vi.fn();
    const open = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
    const card = mountAssistantApp(detail, {
      client: { requestApp } as unknown as AssistantClient,
      sendMessage,
      updateModelContext,
      theme: 'light',
    });
    expect(card).toBeDefined();
    if (!card) return;
    document.body.append(card);
    card.querySelector('iframe')?.dispatchEvent(new Event('load'));

    const teardown = unmountAssistantApp(card);
    await bridge?.onmessage?.({
      role: 'user',
      content: [{ type: 'text', text: 'Continue' }],
    });
    await bridge?.onupdatemodelcontext?.({ structuredContent: { selected: true } });
    await bridge?.onopenlink?.({ url: 'https://example.com' });
    await bridge?.onrequestdisplaymode?.({ mode: 'fullscreen' });
    await bridge?.oncalltool?.({ name: 'refresh_order', arguments: {} });
    await bridge?.onlistresources?.({});
    await bridge?.onreadresource?.({ uri: 'ui://orders/order_1' });

    expect(requestApp).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(updateModelContext).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    finishTeardown?.();
    await teardown;
  });
});

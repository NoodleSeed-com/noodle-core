// @vitest-environment happy-dom
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APP_VIEW_TAG_NAME,
  type NoodleAppViewElement,
  registerNoodleAppView,
} from '../src/app-view.js';
import type { AssistantClient, AssistantViewAvailableDetail } from '../src/client.js';

const view: AssistantViewAvailableDetail = {
  id: 'call_1',
  tool: 'open_order',
  resourceUri: 'ui://orders/order_card',
  title: 'Order',
  result: { orderId: 'order_1' },
  arguments: { orderId: 'order_1' },
  html: '<!doctype html><button id="refresh">Refresh</button>',
};

let bridges: AppBridge[] = [];

function clientFixture() {
  const requestApp = vi.fn(async () => ({
    content: [{ type: 'text', text: 'Updated' }],
  }));
  const sendMessage = vi.fn(async () => {});
  const updateModelContext = vi.fn();
  return {
    client: {
      requestApp,
      sendMessage,
      updateModelContext,
    } as unknown as AssistantClient,
    requestApp,
    sendMessage,
    updateModelContext,
  };
}

function createViewElement(
  client: AssistantClient,
  detail: AssistantViewAvailableDetail = view,
): NoodleAppViewElement {
  const element = document.createElement(APP_VIEW_TAG_NAME) as NoodleAppViewElement;
  // Vue and Angular assign complex bindings as DOM properties before or during connection.
  element.client = client;
  element.view = detail;
  element.theme = 'light';
  document.body.append(element);
  return element;
}

function frame(element: NoodleAppViewElement): HTMLIFrameElement | null {
  return element.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame') ?? null;
}

beforeEach(() => {
  registerNoodleAppView();
  bridges = [];
  vi.spyOn(AppBridge.prototype, 'sendToolInput').mockResolvedValue();
  vi.spyOn(AppBridge.prototype, 'sendToolResult').mockResolvedValue();
  vi.spyOn(AppBridge.prototype, 'sendSandboxResourceReady').mockResolvedValue();
  vi.spyOn(AppBridge.prototype, 'teardownResource').mockResolvedValue({});
  vi.spyOn(PostMessageTransport.prototype, 'close').mockResolvedValue();
  vi.spyOn(AppBridge.prototype, 'connect').mockImplementation(async function () {
    bridges.push(this);
    this.oninitialized?.({});
  });
});

afterEach(async () => {
  document.body.replaceChildren();
  await vi.waitFor(() => {
    expect(document.querySelector(APP_VIEW_TAG_NAME)).toBeNull();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('<noodle-app-view>', () => {
  it('registers idempotently and mounts the secure host from object properties', async () => {
    registerNoodleAppView();
    expect(customElements.get(APP_VIEW_TAG_NAME)).toBeDefined();
    const fixture = clientFixture();
    const element = createViewElement(fixture.client);
    const mountedFrame = frame(element);

    expect(element.shadowRoot?.querySelector('style')).not.toBeNull();
    expect(element.getAttribute('data-theme')).toBe('light');
    expect(mountedFrame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(mountedFrame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(mountedFrame?.getAttribute('src')).toBeNull();
    expect(mountedFrame?.srcdoc).toContain('sandbox-proxy-ready');

    mountedFrame?.dispatchEvent(new Event('load'));
    const bridge = bridges[0];
    expect(bridge).toBeDefined();
    await bridge?.oncalltool?.({ name: 'refresh_order', arguments: { id: 'order_1' } });
    await bridge?.onmessage?.({ role: 'user', content: [{ type: 'text', text: 'Continue' }] });
    await bridge?.onupdatemodelcontext?.({ structuredContent: { orderId: 'order_1' } });

    expect(fixture.requestApp).toHaveBeenCalledWith('tools/call', {
      name: 'refresh_order',
      arguments: { id: 'order_1' },
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith('Continue');
    expect(fixture.updateModelContext).toHaveBeenCalledWith({
      structuredContent: { orderId: 'order_1' },
    });
  });

  it('retains one bridge across payload and theme updates, then tears down semantic replacements', async () => {
    const fixture = clientFixture();
    const element = createViewElement(fixture.client);
    const firstFrame = frame(element);
    firstFrame?.dispatchEvent(new Event('load'));
    const firstBridge = bridges[0];
    const sendHostContextChange = vi.spyOn(AppBridge.prototype, 'sendHostContextChange');
    const updatedHtml = '<!doctype html><button id="refresh">Refresh now</button>';

    element.view = { ...view, result: { orderId: 'order_1', fresh: true }, html: updatedHtml };
    element.theme = 'dark';

    expect(element.getAttribute('data-theme')).toBe('dark');
    expect(frame(element)).toBe(firstFrame);
    expect(bridges).toHaveLength(1);
    expect(AppBridge.prototype.teardownResource).not.toHaveBeenCalled();
    expect(sendHostContextChange).toHaveBeenCalledWith({ theme: 'dark' });
    firstBridge?.onsandboxready?.({});
    expect(AppBridge.prototype.sendSandboxResourceReady).toHaveBeenLastCalledWith({
      html: updatedHtml,
      sandbox: 'allow-scripts',
    });

    element.view = { ...view, id: 'call_2', resourceUri: 'ui://orders/summary' };
    await vi.waitFor(() => {
      expect(AppBridge.prototype.teardownResource).toHaveBeenCalledOnce();
      expect(PostMessageTransport.prototype.close).toHaveBeenCalledOnce();
    });
    expect(frame(element)).not.toBe(firstFrame);

    frame(element)?.dispatchEvent(new Event('load'));
    const replacementClient = clientFixture().client;
    element.client = replacementClient;
    await vi.waitFor(() => {
      expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(2);
      expect(PostMessageTransport.prototype.close).toHaveBeenCalledTimes(2);
    });

    frame(element)?.dispatchEvent(new Event('load'));
    element.remove();
    await vi.waitFor(() => {
      expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(3);
      expect(PostMessageTransport.prototype.close).toHaveBeenCalledTimes(3);
    });
  });

  it('mounts when a same-identity payload later gains a self-contained document', () => {
    const fixture = clientFixture();
    const element = createViewElement(fixture.client, { ...view, html: undefined });
    expect(frame(element)).toBeNull();

    element.view = view;

    expect(frame(element)).not.toBeNull();
  });

  it('surfaces a handshake timeout as a typed element event', () => {
    vi.useFakeTimers();
    const fixture = clientFixture();
    const failures: unknown[] = [];
    const element = document.createElement(APP_VIEW_TAG_NAME) as NoodleAppViewElement;
    element.addEventListener('assistant-error', (event) => failures.push(event.detail));
    element.client = fixture.client;
    element.view = view;
    document.body.append(element);

    vi.runAllTimers();

    expect(failures).toEqual([{ code: 'view_render_timeout', retryable: false }]);
    expect(element.shadowRoot?.querySelector('.noodle-app-fallback')?.textContent).toContain(
      'could not be displayed',
    );
  });

  it('requires explicit host opt-in before an App may enter fullscreen', async () => {
    const fixture = clientFixture();
    const element = createViewElement(fixture.client);
    frame(element)?.dispatchEvent(new Event('load'));
    const inlineExit = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '.noodle-app-fullscreen-exit',
    );

    await expect(bridges[0]?.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({
      mode: 'inline',
    });
    expect(
      element.shadowRoot?.querySelector('.noodle-app-card')?.hasAttribute('data-fullscreen'),
    ).toBe(false);
    expect(inlineExit?.hidden).toBe(true);

    element.allowFullscreen = true;
    const fullscreenFrame = frame(element);
    fullscreenFrame?.dispatchEvent(new Event('load'));
    const sendHostContextChange = vi
      .spyOn(AppBridge.prototype, 'sendHostContextChange')
      .mockResolvedValue();
    await expect(bridges[1]?.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({
      mode: 'fullscreen',
    });
    expect(element.getAttribute('allow-fullscreen')).toBe('');
    expect(
      element.shadowRoot?.querySelector('.noodle-app-card')?.hasAttribute('data-fullscreen'),
    ).toBe(true);
    const fullscreenExit = element.shadowRoot?.querySelector<HTMLButtonElement>(
      '.noodle-app-fullscreen-exit',
    );
    expect(fullscreenExit?.hidden).toBe(false);
    expect(sendHostContextChange).toHaveBeenLastCalledWith({ displayMode: 'fullscreen' });

    element.theme = 'dark';
    expect(sendHostContextChange).toHaveBeenLastCalledWith({ theme: 'dark' });

    const teardownCalls = vi.mocked(AppBridge.prototype.teardownResource).mock.calls.length;
    fullscreenExit?.click();

    expect(
      element.shadowRoot?.querySelector('.noodle-app-card')?.hasAttribute('data-fullscreen'),
    ).toBe(false);
    expect(fullscreenExit?.hidden).toBe(true);
    expect(frame(element)).toBe(fullscreenFrame);
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(teardownCalls);
    expect(sendHostContextChange).toHaveBeenLastCalledWith({ displayMode: 'inline' });
  });

  it('honors an App-requested teardown and does not repeat it on disconnect', async () => {
    const fixture = clientFixture();
    const element = createViewElement(fixture.client);
    frame(element)?.dispatchEvent(new Event('load'));

    bridges[0]?.onrequestteardown?.({});
    await vi.waitFor(() => {
      expect(AppBridge.prototype.teardownResource).toHaveBeenCalledOnce();
      expect(PostMessageTransport.prototype.close).toHaveBeenCalledOnce();
      expect(frame(element)).toBeNull();
    });

    element.remove();
    await Promise.resolve();
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledOnce();
  });
});

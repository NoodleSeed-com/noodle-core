// @vitest-environment happy-dom
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantClient, AssistantViewAvailableDetail } from '../src/client.js';
import { NoodleAppView } from '../src/react.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const view: AssistantViewAvailableDetail = {
  id: 'call_1',
  tool: 'open_order',
  resourceUri: 'ui://orders/order_card',
  title: 'Order',
  result: { orderId: 'order_1' },
  arguments: { orderId: 'order_1' },
  html: '<!doctype html><button id="refresh">Refresh</button>',
};

let root: Root | undefined;
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

async function render(element: React.ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(element));
  return host;
}

function mountedFrame(host: HTMLElement): HTMLIFrameElement | null {
  return (
    host
      .querySelector('noodle-app-view')
      ?.shadowRoot?.querySelector<HTMLIFrameElement>('.noodle-app-frame') ?? null
  );
}

beforeEach(() => {
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
  if (root) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('NoodleAppView', () => {
  it('keeps one iframe and bridge across parent, payload, and callback rerenders', async () => {
    const fixture = clientFixture();
    const firstError = vi.fn();
    const host = await render(
      <NoodleAppView
        className="order-view"
        client={fixture.client}
        view={view}
        onError={firstError}
      />,
    );
    const firstFrame = mountedFrame(host);
    expect(firstFrame).not.toBeNull();

    const replacementError = vi.fn();
    const updatedHtml = '<!doctype html><button id="refresh">Refresh now</button>';
    await act(async () => {
      root?.render(
        <NoodleAppView
          className="order-view updated"
          client={fixture.client}
          view={{
            ...view,
            title: 'Updated order',
            result: { orderId: 'order_1', fresh: true },
            html: updatedHtml,
          }}
          onError={replacementError}
        />,
      );
    });

    expect(mountedFrame(host)).toBe(firstFrame);
    expect(bridges).toHaveLength(1);
    expect(AppBridge.prototype.teardownResource).not.toHaveBeenCalled();
    expect(host.querySelector('.updated')).not.toBeNull();

    bridges[0]?.onsandboxready?.({});
    expect(AppBridge.prototype.sendSandboxResourceReady).toHaveBeenLastCalledWith({
      html: updatedHtml,
      sandbox: 'allow-scripts',
    });

    await act(async () => {
      root?.render(
        <NoodleAppView
          className="order-view settled"
          client={fixture.client}
          view={{ ...view, result: { orderId: 'order_1', fresh: true } }}
          onError={vi.fn()}
        />,
      );
    });
    expect(mountedFrame(host)).toBe(firstFrame);
    expect(bridges).toHaveLength(1);
    expect(AppBridge.prototype.teardownResource).not.toHaveBeenCalled();
  });

  it('publishes resolved host theme changes without replacing the iframe or bridge', async () => {
    const fixture = clientFixture();
    const host = await render(<NoodleAppView client={fixture.client} view={view} theme="light" />);
    const frame = mountedFrame(host);
    frame?.dispatchEvent(new Event('load'));
    const sendHostContextChange = vi.spyOn(AppBridge.prototype, 'sendHostContextChange');

    await act(async () => {
      root?.render(<NoodleAppView client={fixture.client} view={view} theme="dark" />);
    });

    expect(mountedFrame(host)).toBe(frame);
    expect(bridges).toHaveLength(1);
    expect(AppBridge.prototype.teardownResource).not.toHaveBeenCalled();
    expect(sendHostContextChange).toHaveBeenCalledOnce();
    expect(sendHostContextChange).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('passes explicit fullscreen permission to the canonical App host', async () => {
    const fixture = clientFixture();
    const host = await render(
      <NoodleAppView client={fixture.client} view={view} allowFullscreen={true} />,
    );
    mountedFrame(host)?.dispatchEvent(new Event('load'));
    vi.spyOn(AppBridge.prototype, 'sendHostContextChange').mockResolvedValue();

    await expect(bridges[0]?.onrequestdisplaymode?.({ mode: 'fullscreen' })).resolves.toEqual({
      mode: 'fullscreen',
    });
    expect(
      host
        .querySelector('noodle-app-view')
        ?.shadowRoot?.querySelector('.noodle-app-card')
        ?.hasAttribute('data-fullscreen'),
    ).toBe(true);
  });

  it('routes App actions through the client and tears down once per semantic view', async () => {
    const fixture = clientFixture();
    const host = await render(<NoodleAppView client={fixture.client} view={view} />);
    mountedFrame(host)?.dispatchEvent(new Event('load'));
    const firstBridge = bridges[0];
    expect(firstBridge).toBeDefined();

    await firstBridge?.oncalltool?.({ name: 'refresh_order', arguments: { id: 'order_1' } });
    await firstBridge?.onmessage?.({ role: 'user', content: [{ type: 'text', text: 'Continue' }] });
    await firstBridge?.onupdatemodelcontext?.({
      structuredContent: { selectedOrder: 'order_1' },
    });

    expect(fixture.requestApp).toHaveBeenCalledWith('tools/call', {
      name: 'refresh_order',
      arguments: { id: 'order_1' },
    });
    expect(fixture.sendMessage).toHaveBeenCalledWith('Continue');
    expect(fixture.updateModelContext).toHaveBeenCalledWith({
      structuredContent: { selectedOrder: 'order_1' },
    });

    await act(async () => {
      root?.render(
        <NoodleAppView
          client={fixture.client}
          view={{ ...view, id: 'call_2', resourceUri: 'ui://orders/summary' }}
        />,
      );
    });
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(1);
    expect(PostMessageTransport.prototype.close).toHaveBeenCalledTimes(1);

    mountedFrame(host)?.dispatchEvent(new Event('load'));
    const replacement = clientFixture();
    await act(async () => {
      root?.render(
        <NoodleAppView
          client={replacement.client}
          view={{ ...view, id: 'call_2', resourceUri: 'ui://orders/summary' }}
        />,
      );
    });
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(2);
    expect(PostMessageTransport.prototype.close).toHaveBeenCalledTimes(2);

    mountedFrame(host)?.dispatchEvent(new Event('load'));
    await act(async () => root?.unmount());
    root = undefined;
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledTimes(3);
    expect(PostMessageTransport.prototype.close).toHaveBeenCalledTimes(3);
  });

  it('renders no host when the service supplied no self-contained App document', async () => {
    const fixture = clientFixture();
    const host = await render(
      <NoodleAppView client={fixture.client} view={{ ...view, html: undefined }} />,
    );

    expect(mountedFrame(host)).toBeNull();
    expect(bridges).toEqual([]);
  });

  it('removes a mounted host after teardown when the next semantic view has no document', async () => {
    const fixture = clientFixture();
    let finishTeardown: (() => void) | undefined;
    vi.mocked(AppBridge.prototype.teardownResource).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTeardown = () => resolve({});
        }),
    );
    const host = await render(<NoodleAppView client={fixture.client} view={view} />);
    mountedFrame(host)?.dispatchEvent(new Event('load'));

    await act(async () => {
      root?.render(
        <NoodleAppView
          client={fixture.client}
          view={{
            ...view,
            id: 'call_2',
            resourceUri: 'ui://orders/summary',
            html: undefined,
          }}
        />,
      );
    });
    expect(AppBridge.prototype.teardownResource).toHaveBeenCalledOnce();

    await act(async () => finishTeardown?.());
    expect(mountedFrame(host)).toBeNull();
  });
});

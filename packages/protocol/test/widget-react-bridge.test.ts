// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';

// Focused contract tests for the React helper bridge (`__noodleReactBridge`) — the layer behind
// `useOpenExternal()`/`useSendFollowUpMessage()`. The payload shapes here must match the ext-apps
// `App` API exactly: `openLink` takes `{ url }`, and a wrong key silently drops the value on real
// hosts ("No href provided to handleExternalLink" in ChatGPT).

interface CallRecord {
  readonly method: string;
  readonly args: unknown;
}

class MockApp {
  calls: CallRecord[] = [];
  ontoolresult?: (result: unknown) => void;

  constructor() {
    captured = this;
  }

  async connect(): Promise<void> {}

  getHostCapabilities(): unknown {
    return hostCapabilities;
  }

  getHostVersion(): unknown {
    return { name: 'portable-host', version: '2.0.0' };
  }

  getHostContext(): unknown {
    return {
      theme: 'dark',
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { maxWidth: 420, maxHeight: 680 },
      locale: 'ar-PK',
      timeZone: 'Asia/Karachi',
      platform: 'mobile',
      deviceCapabilities: { touch: true, hover: false },
      safeAreaInsets: { top: 12, right: 0, bottom: 18, left: 0 },
    };
  }

  getWidgetState(): unknown {
    return undefined;
  }

  openLink(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'openLink', args });
    return Promise.resolve({});
  }

  sendMessage(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'sendMessage', args });
    return Promise.resolve({});
  }

  requestDisplayMode(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'requestDisplayMode', args });
    return Promise.resolve({ mode: 'fullscreen' });
  }

  updateModelContext(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'updateModelContext', args });
    return Promise.resolve({});
  }
}

let captured: MockApp | undefined;
let hostCapabilities: unknown;

const runSource = Function('source', 'return (0,eval)(source)') as (source: string) => unknown;

interface ReactBridge {
  getLayout(): unknown;
  getToolResult(): unknown;
  openExternal(url: string): unknown;
  requestDisplayMode(mode: 'inline' | 'pip' | 'fullscreen'): unknown;
  sendFollowUpMessage(message: { prompt: string }): unknown;
  updateModelContext(update: unknown): unknown;
}

beforeEach(() => {
  captured = undefined;
  hostCapabilities = {
    serverTools: {},
    openLinks: {},
    message: { text: {} },
    updateModelContext: {},
  };
  document.documentElement.innerHTML = '<head></head><body><div data-surface></div></body>';
  const globals = globalThis as Record<string, unknown>;
  globals.ExtApps = { App: MockApp };
  globals.openai = undefined;
  delete globals.__noodleReactBridge;
  delete globals.__noodleData;
  delete globals.__noodleToolResult;
  delete globals.__noodleReactVersion;
});

async function installBridge(): Promise<{ app: MockApp; bridge: ReactBridge }> {
  runSource(WIDGET_BOOTSTRAP_SOURCE);
  await Promise.resolve();
  const app = captured;
  const bridge = (globalThis as Record<string, unknown>).__noodleReactBridge as
    | ReactBridge
    | undefined;
  if (!app || !bridge) throw new Error('widget bootstrap did not install the react bridge');
  return { app, bridge };
}

describe('react helper bridge host payloads', () => {
  it('reports an empty envelope before the host sends a tool result', async () => {
    const { bridge } = await installBridge();
    expect(bridge.getToolResult()).toEqual({});
  });

  it('preserves an explicitly empty successful tool result', async () => {
    const { app, bridge } = await installBridge();
    const result = { structuredContent: {} };

    app.ontoolresult?.(result);

    expect(bridge.getToolResult()).toBe(result);
  });

  it('preserves the complete canonical result while projecting declarative binding data', async () => {
    const { app, bridge } = await installBridge();
    const result = {
      content: [{ type: 'text', text: '{"answer":42}' }],
      structuredContent: { answer: 42 },
      _meta: { private: true },
      isError: true,
    };

    app.ontoolresult?.(result);

    expect(bridge.getToolResult()).toBe(result);
    expect((globalThis as { __noodleData?: unknown }).__noodleData).toEqual({
      answer: 42,
      _meta: { private: true },
    });
  });

  it('notifies React when an error result has no bindable payload', async () => {
    const { app, bridge } = await installBridge();
    const result = { isError: true };
    const versionBefore = (globalThis as { __noodleReactVersion?: number }).__noodleReactVersion;

    app.ontoolresult?.(result);

    expect(bridge.getToolResult()).toBe(result);
    expect((globalThis as { __noodleReactVersion?: number }).__noodleReactVersion).toBe(
      (versionBefore ?? 0) + 1,
    );
  });

  it('openExternal sends the ext-apps openLink shape ({ url })', async () => {
    const { app, bridge } = await installBridge();
    bridge.openExternal('https://layla.example.com/trip');
    expect(app.calls.find((c) => c.method === 'openLink')?.args).toEqual({
      url: 'https://layla.example.com/trip',
    });
  });

  it('sendFollowUpMessage sends the standard MCP Apps user-message shape', async () => {
    const { app, bridge } = await installBridge();
    bridge.sendFollowUpMessage({ prompt: 'Plan the next leg' });
    expect(app.calls.find((c) => c.method === 'sendMessage')?.args).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Plan the next leg' }],
    });
  });

  it('publishes structured model context through the standard MCP Apps method', async () => {
    const { app, bridge } = await installBridge();
    await bridge.updateModelContext({
      structuredContent: { formOpen: true, lifecycle: 'rendered' },
    });
    expect(app.calls.find((c) => c.method === 'updateModelContext')?.args).toEqual({
      structuredContent: { formOpen: true, lifecycle: 'rendered' },
    });
  });

  it('preserves the standard MCP Apps host context and display-mode request shape', async () => {
    const { app, bridge } = await installBridge();
    expect(bridge.getLayout()).toEqual({
      theme: 'dark',
      displayMode: 'pip',
      availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      containerDimensions: { maxWidth: 420, maxHeight: 680 },
      locale: 'ar-PK',
      timeZone: 'Asia/Karachi',
      host: 'portable-host',
      platform: 'mobile',
      deviceCapabilities: { touch: true, hover: false },
      safeAreaInsets: { top: 12, right: 0, bottom: 18, left: 0 },
      supports: {
        fullscreen: true,
        pip: true,
        openExternal: true,
        followUpMessage: true,
        modelContext: true,
      },
    });

    await bridge.requestDisplayMode('fullscreen');
    expect(app.calls.find((call) => call.method === 'requestDisplayMode')?.args).toEqual({
      mode: 'fullscreen',
    });
  });

  it('does not advertise optional actions that the host did not declare', async () => {
    hostCapabilities = {};
    const { bridge } = await installBridge();
    expect(bridge.getLayout()).toMatchObject({
      supports: { openExternal: false, followUpMessage: false, modelContext: false },
    });
  });
});

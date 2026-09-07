// @vitest-environment happy-dom
/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

interface OpenAiMock {
  widgetState?: unknown;
  callTool(): Promise<unknown>;
  setWidgetState(update: unknown): Promise<unknown>;
  updateModelContext?: (update: unknown) => Promise<unknown>;
}

interface ReactBridge {
  setWidgetState(patch: Record<string, unknown>): void;
  updateModelContext(update: unknown): Promise<unknown>;
}

const globals = globalThis as unknown as {
  ExtApps?: unknown;
  __noodleReactBridge?: ReactBridge;
  openai?: OpenAiMock;
};

describe('widget model-context persistence and safety', () => {
  let calls: Array<{ method: string; args: unknown }>;
  let openai: OpenAiMock;

  beforeEach(() => {
    calls = [];
    openai = {
      callTool: () => Promise.resolve({}),
      setWidgetState(update: unknown): Promise<unknown> {
        calls.push({ method: 'setWidgetState', args: update });
        this.widgetState = update;
        return Promise.resolve({});
      },
    };
    globals.openai = openai;
    globals.ExtApps = undefined;
    globals.__noodleReactBridge = undefined;
  });

  async function installRuntime(): Promise<void> {
    document.body.innerHTML =
      '<button id="context" data-action="context" data-action-text="noted">Publish</button>';
    await runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
  }

  afterEach(() => {
    globals.openai = undefined;
    globals.__noodleReactBridge = undefined;
  });

  it('preserves fallback model context across later private widget-state writes', async () => {
    await installRuntime();
    document.querySelector<HTMLButtonElement>('#context')?.click();
    await Promise.resolve();
    globals.__noodleReactBridge?.setWidgetState({ draft: 'private only' });

    expect(calls.filter((call) => call.method === 'setWidgetState').at(-1)?.args).toMatchObject({
      modelContent: 'noted',
      privateContent: { state: { draft: 'private only' } },
      imageIds: [],
    });
  });

  it('preserves directly published model context across later private state writes', async () => {
    openai.updateModelContext = (update: unknown): Promise<unknown> => {
      calls.push({ method: 'updateModelContext', args: update });
      return Promise.resolve({});
    };
    await installRuntime();
    document.querySelector<HTMLButtonElement>('#context')?.click();
    await Promise.resolve();
    globals.__noodleReactBridge?.setWidgetState({ draft: 'private after direct update' });

    expect(calls.find((call) => call.method === 'updateModelContext')?.args).toEqual({
      content: [{ type: 'text', text: 'noted' }],
    });
    expect(calls.filter((call) => call.method === 'setWidgetState').at(-1)?.args).toMatchObject({
      modelContent: 'noted',
      privateContent: { state: { draft: 'private after direct update' } },
    });
  });

  it('rejects sensitive and oversized context at the shared bridge boundary', async () => {
    await installRuntime();
    expect(() =>
      globals.__noodleReactBridge?.updateModelContext({ content: { accessToken: 'do-not-send' } }),
    ).toThrow(/sensitive key/i);
    expect(() =>
      globals.__noodleReactBridge?.updateModelContext({
        content: [{ type: 'text', text: `Bearer ${'a'.repeat(24)}` }],
      }),
    ).toThrow(/credential-shaped text/i);
    expect(() =>
      globals.__noodleReactBridge?.updateModelContext({ content: 'x'.repeat(17 * 1024) }),
    ).toThrow(/16 KiB/i);
    expect(calls).toEqual([]);
  });

  it.each([
    'own',
    'inherited',
  ] as const)('rejects nested credential-bearing %s toJSON hooks at the raw bridge boundary', async (kind) => {
    openai.updateModelContext = (update: unknown): Promise<unknown> => {
      calls.push({ method: 'updateModelContext', args: update });
      return Promise.resolve({});
    };
    await installRuntime();
    const widget = { lifecycle: 'mounted' };
    const toJSON = () => ({ lifecycle: 'mounted', apiKey: 'must-not-cross-the-bridge' });
    if (kind === 'own') {
      Object.defineProperty(widget, 'toJSON', { value: toJSON });
    } else {
      Object.setPrototypeOf(widget, { toJSON });
    }

    expect(() =>
      globals.__noodleReactBridge?.updateModelContext({ structuredContent: { widget } }),
    ).toThrow(/toJSON|plain record/i);
    expect(calls).toEqual([]);
  });

  it('forwards a detached canonical model-context snapshot through the raw bridge', async () => {
    openai.updateModelContext = (update: unknown): Promise<unknown> => {
      calls.push({ method: 'updateModelContext', args: update });
      return Promise.resolve({});
    };
    await installRuntime();
    const widget = { lifecycle: 'mounted' };
    const original = { structuredContent: { widget } };
    await globals.__noodleReactBridge?.updateModelContext(original);
    widget.lifecycle = 'forged-after-publication';

    expect(calls.find((call) => call.method === 'updateModelContext')?.args).toEqual({
      structuredContent: { widget: { lifecycle: 'mounted' } },
    });
  });

  it('projects getter-backed model context once at the raw bridge boundary', async () => {
    openai.updateModelContext = (update: unknown): Promise<unknown> => {
      calls.push({ method: 'updateModelContext', args: update });
      return Promise.resolve({});
    };
    await installRuntime();
    let reads = 0;
    const widget = Object.defineProperty({}, 'lifecycle', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'mounted' : `Bearer ${'a'.repeat(24)}`;
      },
    });
    await globals.__noodleReactBridge?.updateModelContext({ structuredContent: { widget } });

    expect(reads).toBe(1);
    expect(calls.find((call) => call.method === 'updateModelContext')?.args).toEqual({
      structuredContent: { widget: { lifecycle: 'mounted' } },
    });
  });
});

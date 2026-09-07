// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

type Handler = (params: unknown) => unknown;

let captured: ReadinessHost | undefined;
let releaseConnect: (() => void) | undefined;

class ReadinessHost {
  readonly handlers: Record<string, Handler | undefined> = {};
  readonly calls: Array<{ method: string; args: unknown }> = [];
  connected = false;

  constructor(_info: unknown, _caps: unknown, _options: unknown) {
    captured = this;
  }

  set ontoolresult(handler: Handler | undefined) {
    this.handlers.toolresult = handler;
  }
  set ontoolinput(handler: Handler | undefined) {
    this.handlers.toolinput = handler;
  }
  set ontoolcancelled(handler: Handler | undefined) {
    this.handlers.toolcancelled = handler;
  }
  set onhostcontextchanged(handler: Handler | undefined) {
    this.handlers.hostcontextchanged = handler;
  }
  set onteardown(handler: Handler | undefined) {
    this.handlers.teardown = handler;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    this.connected = true;
  }

  getHostContext(): undefined {
    return undefined;
  }
  getHostCapabilities(): Readonly<Record<string, boolean>> {
    return { tools: true };
  }
  callServerTool(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'callServerTool', args });
    return Promise.resolve({ content: [] });
  }
}

const globals = globalThis as unknown as {
  ExtApps?: unknown;
  __noodleReactBridge?: unknown;
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  captured = undefined;
  releaseConnect = undefined;
  globals.__noodleReactBridge = undefined;
  globals.ExtApps = {
    App: ReadinessHost,
    applyHostStyleVariables: () => undefined,
    applyHostFonts: () => undefined,
  };
  document.body.innerHTML = `
    <button id="call" type="button" data-action="call" data-action-tool="save_job">Save</button>
  `;
});

describe('widget runtime connection readiness', () => {
  it('keeps bridge-backed actions unavailable until the host connection completes', async () => {
    const running = Promise.resolve(runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE));
    await flush();

    const app = captured;
    expect(app).toBeDefined();
    if (!app) throw new Error('expected the MCP Apps host to be constructed');
    expect(typeof app.handlers.toolresult).toBe('function');
    expect(typeof app.handlers.toolinput).toBe('function');
    expect(app.connected).toBe(false);
    expect(globals.__noodleReactBridge).toBeUndefined();

    document.querySelector<HTMLButtonElement>('#call')?.click();
    expect(app.calls).toEqual([]);

    releaseConnect?.();
    await running;

    expect(app.connected).toBe(true);
    expect(globals.__noodleReactBridge).toBeDefined();
    document.querySelector<HTMLButtonElement>('#call')?.click();
    expect(app.calls).toContainEqual({
      method: 'callServerTool',
      args: { name: 'save_job', arguments: {} },
    });
  });
});

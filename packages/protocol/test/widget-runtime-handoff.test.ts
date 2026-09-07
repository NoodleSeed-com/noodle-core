// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

interface MockHost {
  calls: Array<{ method: string; args: unknown }>;
  getHostCapabilities(): unknown;
  getHostContext(): unknown;
  openLink(params: unknown): Promise<unknown>;
  connect(): Promise<void>;
}

let captured: MockHost | undefined;

class MockApp implements MockHost {
  calls: Array<{ method: string; args: unknown }> = [];

  constructor() {
    captured = this;
  }

  set ontoolresult(_fn: unknown) {}
  set ontoolinput(_fn: unknown) {}
  set ontoolcancelled(_fn: unknown) {}
  set onhostcontextchanged(_fn: unknown) {}
  set onteardown(_fn: unknown) {}

  async connect(): Promise<void> {}

  getHostCapabilities(): unknown {
    return { openLink: true };
  }

  getHostContext(): unknown {
    return {};
  }

  openLink(args: unknown): Promise<unknown> {
    this.calls.push({ method: 'openLink', args });
    return Promise.resolve({});
  }
}

const globals = globalThis as unknown as {
  ExtApps?: unknown;
  __noodleState?: unknown;
};

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error('expected a value');
  return value;
}

function button(): HTMLButtonElement {
  return must(document.querySelector<HTMLButtonElement>('#checkout'));
}

async function installRuntime(): Promise<MockHost> {
  document.body.innerHTML = `
    <script type="application/json" data-noodle-policy>{"handoff":{"allowedDomains":["https://checkout.example.com"]}}</script>
    <button id="checkout" data-action="open" data-action-handoff-session="state:checkout">Checkout</button>
  `;
  globals.__noodleState = undefined;
  captured = undefined;
  await runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
  return must(captured);
}

beforeEach(() => {
  globals.ExtApps = { App: MockApp, applyHostStyleVariables: () => {}, applyHostFonts: () => {} };
});

describe('widget runtime handoff sessions', () => {
  it('opens session-backed handoff URLs only when fresh, http(s), and allowlisted', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const app = await installRuntime();

    button().click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(0);
    expect(document.querySelector('[data-noodle-error]')?.textContent).toContain('not ready');

    globals.__noodleState = {
      checkout: {
        url: 'https://checkout.example.com/pay?secret=abc',
        purpose: 'checkout',
        provider: 'example',
        expiresAt: future,
      },
    };
    button().click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(app.calls[0]?.args).toEqual({ url: 'https://checkout.example.com/pay?secret=abc' });

    globals.__noodleState = {
      checkout: {
        url: 'https://checkout.example.com/pay?secret=abc',
        purpose: 'checkout',
        expiresAt: past,
      },
    };
    button().click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(document.querySelector('[data-noodle-error]')?.textContent).toContain('expired');

    globals.__noodleState = {
      checkout: {
        url: 'https://evil.example.com/pay?secret=abc',
        purpose: 'checkout',
        expiresAt: future,
      },
    };
    button().click();
    expect(app.calls.filter((c) => c.method === 'openLink')).toHaveLength(1);
    expect(document.querySelector('[data-noodle-error]')?.textContent).toContain('not allowed');
    expect(document.querySelector('[data-noodle-error]')?.textContent).not.toContain('secret=abc');
  });
});

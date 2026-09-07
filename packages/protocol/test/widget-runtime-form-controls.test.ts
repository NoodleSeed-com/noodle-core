// @vitest-environment happy-dom
/// <reference lib="dom" />
import { beforeEach, describe, expect, it } from 'vitest';
import { WIDGET_BOOTSTRAP_SOURCE } from '../src/widget/bootstrap.js';
import { runWidgetRuntimeSource } from './widget-runtime-eval.js';

interface MockHost {
  handlers: Record<string, ((params: unknown) => unknown) | undefined>;
  calls: Array<{ method: string; args: unknown }>;
  callServerTool(params: unknown): Promise<unknown>;
  connect(): Promise<void>;
  getHostCapabilities(): unknown;
  getHostContext(): unknown;
}

let captured: MockHost | undefined;

class MockApp implements MockHost {
  handlers: Record<string, ((params: unknown) => unknown) | undefined> = {};
  calls: Array<{ method: string; args: unknown }> = [];

  constructor() {
    captured = this;
  }

  set ontoolresult(fn: ((params: unknown) => unknown) | undefined) {
    this.handlers.toolresult = fn;
  }
  set ontoolinput(fn: ((params: unknown) => unknown) | undefined) {
    this.handlers.toolinput = fn;
  }
  set ontoolcancelled(fn: ((params: unknown) => unknown) | undefined) {
    this.handlers.toolcancelled = fn;
  }
  set onhostcontextchanged(fn: ((params: unknown) => unknown) | undefined) {
    this.handlers.hostcontextchanged = fn;
  }
  set onteardown(fn: ((params: unknown) => unknown) | undefined) {
    this.handlers.teardown = fn;
  }

  async connect(): Promise<void> {}
  getHostCapabilities(): unknown {
    return { tools: true };
  }
  getHostContext(): unknown {
    return {};
  }
  callServerTool(params: unknown): Promise<unknown> {
    this.calls.push({ method: 'callServerTool', args: params });
    return Promise.resolve({ structuredContent: {} });
  }
}

const globals = globalThis as unknown as { ExtApps?: unknown; __noodleState?: unknown };

beforeEach(() => {
  captured = undefined;
  globals.__noodleState = undefined;
  globals.ExtApps = {
    App: MockApp,
    applyDocumentTheme() {},
    applyHostFonts() {},
    applyHostStyleVariables() {},
  };
});

describe('widget runtime grouped form controls', () => {
  it('collects radio, checkbox group, quantity, and confirmation state for tool calls', async () => {
    document.body.innerHTML = `
      <form>
        <input type="radio" name="size" value="small" data-state-name="size">
        <input type="radio" name="size" value="large" data-state-name="size" checked>
        <input type="checkbox" value="mint" data-state-name="addons" data-state-kind="checkbox-group" checked>
        <input type="checkbox" value="sauce" data-state-name="addons" data-state-kind="checkbox-group">
        <input type="number" data-state-name="quantity" value="2">
        <input type="checkbox" data-state-name="confirmed" data-confirmation="true" checked>
        <button id="submit" type="button" data-action="call" data-action-tool="save_order">Save</button>
      </form>
    `;

    runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector<HTMLButtonElement>('#submit')?.click();

    expect(captured?.calls.find((call) => call.method === 'callServerTool')?.args).toEqual({
      name: 'save_order',
      arguments: {
        size: 'large',
        addons: ['mint'],
        quantity: '2',
        confirmed: true,
      },
    });
  });

  it('does not make a raw native form appear portable by cancelling submission for the author', async () => {
    document.body.innerHTML = `
      <form id="native-form">
        <button type="submit">Submit</button>
      </form>
    `;

    runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const form = document.querySelector<HTMLFormElement>('#native-form');
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
    const accepted = form?.dispatchEvent(event);

    expect(accepted).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('widget runtime locale formatting', () => {
  it('formats bound text and table cells during render', async () => {
    document.body.innerHTML = `
      <p id="price" data-bind="total" data-format-kind="currency" data-format-currency="EUR" data-format-locale="de-DE"></p>
      <p id="date" data-bind="startsAt" data-format-kind="dateTime" data-format-locale="en-GB" data-format-date-style="medium" data-format-time-style="short" data-format-time-zone="Europe/London"></p>
      <p id="plural" data-bind="count" data-format-kind="plural" data-format-locale="en-US" data-format-one="1 item" data-format-other="items"></p>
      <table data-rows="rows"><tbody><tr><td data-column-path="name"></td><td data-column-path="price" data-column-format='{"kind":"currency","currency":"USD","locale":"en-US"}'></td></tr></tbody></table>
    `;
    globalThis.__noodleData = {
      total: 1234.5,
      startsAt: '2026-06-11T12:00:00.000Z',
      count: 3,
      rows: [{ name: 'Ticket', price: 42 }],
    };

    runWidgetRuntimeSource(WIDGET_BOOTSTRAP_SOURCE);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('#price')?.textContent).toBe('1.234,50 €');
    expect(document.querySelector('#date')?.textContent).toBe('11 Jun 2026, 13:00');
    expect(document.querySelector('#plural')?.textContent).toBe('3 items');
    expect(document.querySelectorAll('tbody td')[1]?.textContent).toBe('$42.00');
  });
});

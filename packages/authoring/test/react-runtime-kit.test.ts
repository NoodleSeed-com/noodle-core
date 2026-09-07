// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Action,
  type AppFlow,
  AppShell,
  AsyncBoundary,
  Checkbox,
  ChoiceGroup,
  Collection,
  createViewStore,
  DataCard,
  DataList,
  ExpandButton,
  Fact,
  Feedback,
  Field,
  Flow,
  Frame,
  FullscreenShell,
  generateHelpers,
  HandoffButton,
  InlineCard,
  InlineCarousel,
  InlineList,
  Input,
  type NoodleReactBridge,
  Overlay,
  QuantityStepper,
  RadioGroup,
  Region,
  Select,
  ShellNav,
  Slider,
  StatusBadge,
  Switch,
  Textarea,
  type ToolResult,
  View,
  ViewNav,
  ViewStack,
} from '../src/react.js';

type CallRecord = {
  readonly method: string;
  readonly args: unknown;
};

class MockBridge implements NoodleReactBridge {
  readonly calls: CallRecord[] = [];
  viewState: Record<string, unknown> = {};
  layout = {
    theme: 'light' as const,
    displayMode: 'inline' as const,
    locale: 'en-US',
    host: 'chatgpt' as const,
    supports: { fullscreen: true, pip: true, openExternal: true },
  };

  getToolResult(): ToolResult {
    return { structuredContent: { ready: true } };
  }

  getViewState(): Record<string, unknown> {
    return { ...this.viewState };
  }

  getLayout() {
    return this.layout;
  }

  setWidgetState(patch: Record<string, unknown>): void {
    this.viewState = { ...patch };
    this.calls.push({ method: 'setWidgetState', args: patch });
    bump();
  }

  callServerTool(request: {
    readonly name: string;
    readonly arguments?: unknown;
  }): Promise<ToolResult> {
    this.calls.push({ method: 'callServerTool', args: request });
    return Promise.resolve({
      structuredContent: { ok: true, request },
      _meta: { source: 'test' },
    });
  }

  openExternal(url: string): Promise<void> {
    this.calls.push({ method: 'openExternal', args: url });
    return Promise.resolve();
  }

  requestDisplayMode(mode: 'inline' | 'pip' | 'fullscreen'): Promise<void> {
    this.calls.push({ method: 'requestDisplayMode', args: mode });
    this.layout = { ...this.layout, displayMode: mode };
    bump();
    return Promise.resolve();
  }

  updateModelContext(update: unknown): Promise<void> {
    this.calls.push({ method: 'updateModelContext', args: update });
    return Promise.resolve();
  }
}

let bridge: MockBridge;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  bridge = new MockBridge();
  if (root) act(() => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  root = undefined;
  const globals = globalThis as {
    __noodleReactBridge?: NoodleReactBridge;
    __noodleReactVersion?: number;
  };
  globals.__noodleReactBridge = bridge;
  globals.__noodleReactVersion = 0;
});

describe('React runtime kit hooks', () => {
  it('reports bridge readiness only after the portable bridge is installed', () => {
    const helpers = generateHelpers<unknown>();
    const readinessHelpers = helpers as typeof helpers & {
      readonly useWidgetReady?: () => boolean;
    };
    let ready: boolean | undefined;

    function Probe() {
      ready = readinessHelpers.useWidgetReady?.() ?? true;
      return null;
    }

    const globals = globalThis as {
      __noodleReactBridge?: NoodleReactBridge;
      __noodleReactVersion?: number;
    };
    globals.__noodleReactBridge = undefined;
    render(h(Probe));
    expect(ready).toBe(false);

    act(() => {
      globals.__noodleReactBridge = bridge;
      bump();
    });
    expect(ready).toBe(true);
  });

  it('publishes the mounted lifecycle once when a delayed bridge becomes ready', async () => {
    const helpers = generateHelpers<unknown>();
    const globals = globalThis as {
      __noodleReactBridge?: NoodleReactBridge;
      __noodleReactVersion?: number;
    };
    globals.__noodleReactBridge = undefined;

    function Probe() {
      helpers.useWidgetLifecycle('delayed-widget');
      return null;
    }

    render(h(Probe));
    expect(bridge.calls).toEqual([]);

    await act(async () => {
      globals.__noodleReactBridge = bridge;
      bump();
      await Promise.resolve();
    });

    expect(bridge.calls).toEqual([
      {
        method: 'updateModelContext',
        args: {
          content: [{ type: 'text', text: 'Widget delayed-widget was mounted.' }],
          structuredContent: {
            widget: { name: 'delayed-widget', lifecycle: 'mounted' },
          },
        },
      },
    ]);
  });

  it('tracks tool-call lifecycle with structured content and reset', async () => {
    const helpers = generateHelpers<unknown>();
    let call: ReturnType<(typeof helpers)['useCallTool']> | undefined;

    function Probe() {
      call = helpers.useCallTool('load_item');
      return h(
        'button',
        { type: 'button', onClick: () => void call?.callToolAsync({ id: 'item_1' }) },
        'load',
      );
    }

    render(h(Probe));
    expect(call?.status).toBe('idle');

    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(call?.status).toBe('success');
    expect(call?.structuredContent).toMatchObject({ ok: true });
    expect(call?.meta).toEqual({ source: 'test' });
    expect(bridge.calls.find((entry) => entry.method === 'callServerTool')?.args).toMatchObject({
      name: 'load_item',
      arguments: { id: 'item_1' },
    });

    act(() => call?.reset());
    expect(call?.status).toBe('idle');
  });

  it('persists app flow and view-store state through widget state', () => {
    const helpers = generateHelpers<unknown>();
    const useCartStore = createViewStore('cart', () => ({ count: 0 }));
    let flow: AppFlow<'stores' | 'cart'> | undefined;
    let cart: ReturnType<typeof useCartStore> | undefined;

    function Probe() {
      flow = helpers.useAppFlow({
        key: 'ordering_flow',
        initialView: 'stores',
        views: ['stores', 'cart'],
      });
      cart = useCartStore();
      return h(
        'div',
        null,
        h(
          'button',
          { type: 'button', onClick: () => flow?.navigate('cart', { source: 'test' }) },
          'cart',
        ),
        h(
          'button',
          { type: 'button', onClick: () => cart?.patchState({ count: cart.state.count + 1 }) },
          'add',
        ),
        h('span', null, flow.activeView),
        h('span', null, cart.state.count),
      );
    }

    render(h(Probe));
    act(() =>
      document
        .querySelectorAll('button')[0]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    act(() =>
      document
        .querySelectorAll('button')[1]
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(flow?.activeView).toBe('cart');
    expect(flow?.params).toEqual({ source: 'test' });
    expect(cart?.state.count).toBe(1);
    expect(bridge.viewState.ordering_flow).toMatchObject({ activeView: 'cart' });
    expect(bridge.viewState.cart).toEqual({ count: 1 });

    act(() => flow?.back());
    expect(flow?.activeView).toBe('stores');
  });

  it('opens only http handoff targets through the bridge', async () => {
    const helpers = generateHelpers<unknown>();
    let handoff: ReturnType<(typeof helpers)['useHandoff']> | undefined;

    function Probe() {
      handoff = helpers.useHandoff();
      return h(
        'button',
        {
          type: 'button',
          onClick: () => void handoff?.open({ url: 'https://orders.example.com/checkout' }),
        },
        'open',
      );
    }

    render(h(Probe));
    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(handoff?.status).toBe('opened');
    expect(bridge.calls.find((entry) => entry.method === 'openExternal')?.args).toBe(
      'https://orders.example.com/checkout',
    );

    await expect(handoff?.open('javascript:alert(1)')).rejects.toThrow('http or https');
  });

  it('exposes host layout capabilities and requests alternate display modes', async () => {
    const helpers = generateHelpers<unknown>();
    let layout: ReturnType<(typeof helpers)['useLayout']> | undefined;
    let requestDisplayMode: ReturnType<(typeof helpers)['useRequestDisplayMode']> | undefined;

    function Probe() {
      layout = helpers.useLayout();
      requestDisplayMode = helpers.useRequestDisplayMode();
      return h('button', {
        type: 'button',
        onClick: () => void requestDisplayMode?.('fullscreen'),
      });
    }

    render(h(Probe));
    expect(layout).toMatchObject({
      displayMode: 'inline',
      host: 'chatgpt',
      supports: { fullscreen: true, pip: true },
    });

    await act(async () => {
      document.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(bridge.calls.find((entry) => entry.method === 'requestDisplayMode')?.args).toBe(
      'fullscreen',
    );
    expect(layout?.displayMode).toBe('fullscreen');
  });

  it('publishes explicit model-visible summaries and structured widget lifecycle events', async () => {
    const helpers = generateHelpers<unknown>();
    let update: ReturnType<(typeof helpers)['useUpdateModelContext']> | undefined;
    let lifecycle: ReturnType<(typeof helpers)['useWidgetLifecycle']> | undefined;

    function Probe() {
      update = helpers.useUpdateModelContext();
      lifecycle = helpers.useWidgetLifecycle('time-off-request');
      return h(
        'div',
        null,
        h('button', {
          id: 'state',
          type: 'button',
          onClick: () =>
            void update?.({
              structuredContent: { formOpen: true, type: 'VACATION', start: null, end: null },
            }),
        }),
        h('button', {
          id: 'submitted',
          type: 'button',
          onClick: () =>
            void lifecycle?.('submitted', { requestId: 'leave-123', status: 'pending' }),
        }),
      );
    }

    render(h(Probe));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('#state')?.click();
      document.querySelector<HTMLButtonElement>('#submitted')?.click();
      await Promise.resolve();
    });

    expect(bridge.calls.filter((entry) => entry.method === 'updateModelContext')).toEqual([
      {
        method: 'updateModelContext',
        args: {
          content: [{ type: 'text', text: 'Widget time-off-request was mounted.' }],
          structuredContent: {
            widget: { name: 'time-off-request', lifecycle: 'mounted' },
          },
        },
      },
      {
        method: 'updateModelContext',
        args: {
          structuredContent: { formOpen: true, type: 'VACATION', start: null, end: null },
        },
      },
      {
        method: 'updateModelContext',
        args: {
          content: [{ type: 'text', text: 'Widget time-off-request was submitted.' }],
          structuredContent: {
            widget: {
              name: 'time-off-request',
              lifecycle: 'submitted',
              requestId: 'leave-123',
              status: 'pending',
            },
          },
        },
      },
    ]);

    await act(async () => {
      globalThis.dispatchEvent(new CustomEvent('noodle:toolcancelled'));
      globalThis.dispatchEvent(new CustomEvent('noodle:teardown'));
      await Promise.resolve();
    });
    expect(
      bridge.calls
        .filter((entry) => entry.method === 'updateModelContext')
        .slice(-2)
        .map((entry) => entry.args),
    ).toEqual([
      {
        content: [{ type: 'text', text: 'Widget time-off-request was cancelled.' }],
        structuredContent: {
          widget: { name: 'time-off-request', lifecycle: 'cancelled' },
        },
      },
      {
        content: [{ type: 'text', text: 'Widget time-off-request was dismissed.' }],
        structuredContent: {
          widget: { name: 'time-off-request', lifecycle: 'dismissed' },
        },
      },
    ]);
  });

  it('rejects unbounded or credential-shaped model context before calling the host', async () => {
    const helpers = generateHelpers<unknown>();
    let update: ReturnType<(typeof helpers)['useUpdateModelContext']> | undefined;

    function Probe() {
      update = helpers.useUpdateModelContext();
      return null;
    }

    render(h(Probe));

    await expect(
      update?.({ structuredContent: { apiKey: 'must-not-cross-the-bridge' } }),
    ).rejects.toThrow('sensitive key');
    await expect(
      update?.({ content: [{ type: 'text', text: `Bearer ${'a'.repeat(24)}` }] }),
    ).rejects.toThrow('credential-shaped text');
    await expect(
      update?.({ structuredContent: { summary: 'x'.repeat(17 * 1024) } }),
    ).rejects.toThrow('16 KiB');
    expect(bridge.calls.filter((entry) => entry.method === 'updateModelContext')).toEqual([]);
  });

  it.each([
    'own',
    'inherited',
  ] as const)('rejects nested credential-bearing %s toJSON hooks before calling the host', async (kind) => {
    const helpers = generateHelpers<unknown>();
    let update: ReturnType<(typeof helpers)['useUpdateModelContext']> | undefined;

    function Probe() {
      update = helpers.useUpdateModelContext();
      return null;
    }

    render(h(Probe));
    const widget = { lifecycle: 'mounted' };
    const toJSON = () => ({ lifecycle: 'mounted', apiKey: 'must-not-cross-the-bridge' });
    if (kind === 'own') {
      Object.defineProperty(widget, 'toJSON', { value: toJSON });
    } else {
      Object.setPrototypeOf(widget, { toJSON });
    }

    await expect(update?.({ structuredContent: { widget } })).rejects.toThrow(
      /toJSON|plain record/i,
    );
    expect(bridge.calls.filter((entry) => entry.method === 'updateModelContext')).toEqual([]);
  });

  it('forwards a detached canonical model-context snapshot to the host', async () => {
    const helpers = generateHelpers<unknown>();
    let update: ReturnType<(typeof helpers)['useUpdateModelContext']> | undefined;

    function Probe() {
      update = helpers.useUpdateModelContext();
      return null;
    }

    render(h(Probe));
    const widget = { lifecycle: 'mounted' };
    const original = { structuredContent: { widget } };
    await update?.(original);
    widget.lifecycle = 'forged-after-publication';

    expect(bridge.calls.find((entry) => entry.method === 'updateModelContext')?.args).toEqual({
      structuredContent: { widget: { lifecycle: 'mounted' } },
    });
  });

  it('projects getter-backed model context once before calling the host', async () => {
    const helpers = generateHelpers<unknown>();
    let update: ReturnType<(typeof helpers)['useUpdateModelContext']> | undefined;

    function Probe() {
      update = helpers.useUpdateModelContext();
      return null;
    }

    render(h(Probe));
    let reads = 0;
    const widget = Object.defineProperty({}, 'lifecycle', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? 'mounted' : `Bearer ${'a'.repeat(24)}`;
      },
    });
    await update?.({ structuredContent: { widget } });

    expect(reads).toBe(1);
    expect(bridge.calls.find((entry) => entry.method === 'updateModelContext')?.args).toEqual({
      structuredContent: { widget: { lifecycle: 'mounted' } },
    });
  });

  it('exposes the server brand kit to React widgets', () => {
    const helpers = generateHelpers<unknown>();
    (globalThis as { __noodleBranding?: unknown }).__noodleBranding = {
      name: 'Acme',
      logo: { uri: 'https://assets.example/logo.svg', alt: 'Acme' },
    };
    let branding: ReturnType<(typeof helpers)['useBranding']> | undefined;
    function Probe() {
      branding = helpers.useBranding();
      return null;
    }
    render(h(Probe));
    expect(branding).toMatchObject({ name: 'Acme', logo: { alt: 'Acme' } });
    delete (globalThis as { __noodleBranding?: unknown }).__noodleBranding;
  });
});

describe('React runtime kit components', () => {
  it('renders shell, navigation, views, controls, and handoff button', async () => {
    const helpers = generateHelpers<unknown>();
    function Probe() {
      const flow = helpers.useAppFlow({
        key: 'component_flow',
        initialView: 'stores',
        views: ['stores', 'cart'],
      });
      const handoff = helpers.useHandoff();
      const quantity = useMemo(() => ({ value: 1 }), []);
      return h(
        AppShell,
        { title: 'Food Ordering', subtitle: 'Demo app', badge: flow.activeView },
        h(ShellNav, {
          activeView: flow.activeView,
          items: [
            { view: 'stores', label: 'Stores' },
            { view: 'cart', label: 'Cart' },
          ],
          onNavigate: flow.navigate,
        }),
        h(
          ViewStack,
          { flow },
          h(
            View,
            { name: 'stores' },
            h(Field, { label: 'Customer' }, h('input', { 'aria-label': 'customer' })),
            h(QuantityStepper, {
              value: quantity.value,
              min: 1,
              onChange: (value: number) => {
                quantity.value = value;
              },
            }),
            h(ChoiceGroup, {
              values: ['warm', 'spicy'],
              selected: ['warm'],
              onChange: () => undefined,
            }),
            h(
              DataList,
              null,
              h(
                DataCard,
                { as: 'button', type: 'button' },
                'Noodle Bar',
                h(StatusBadge, { tone: 'success' }, 'Open'),
              ),
            ),
          ),
          h(
            View,
            { name: 'cart' },
            h(
              AsyncBoundary,
              { state: { status: 'success' } },
              h(
                HandoffButton,
                { handoff, target: 'https://orders.example.com/checkout' },
                'Checkout',
              ),
            ),
          ),
        ),
      );
    }

    render(h(Probe));
    expect(document.querySelector('.nsr-shell')?.textContent).toContain('Food Ordering');
    expect(document.querySelector('.nsr-view')?.textContent).toContain('Customer');

    act(() => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Cart')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.nsr-view')?.textContent).toContain('Checkout');

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Checkout')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(bridge.calls.find((entry) => entry.method === 'openExternal')?.args).toBe(
      'https://orders.example.com/checkout',
    );
  });

  it('renders ChatGPT-native inline and fullscreen primitives', async () => {
    function Probe() {
      return h(
        'div',
        null,
        h(
          InlineCard,
          {
            title: 'Order ready',
            description: 'Two items are ready for review.',
            primaryAction: h('button', { type: 'button' }, 'Review'),
            secondaryAction: h('button', { type: 'button' }, 'Dismiss'),
          },
          h(InlineList, {
            items: [
              { id: 'a', title: 'Soba bowl', meta: '$12' },
              { id: 'b', title: 'Tea', meta: '$4' },
            ],
          }),
        ),
        h(
          InlineCarousel,
          {
            items: [
              { id: '1', title: 'Store one' },
              { id: '2', title: 'Store two' },
              { id: '3', title: 'Store three' },
              { id: '4', title: 'Store four' },
              { id: '5', title: 'Store five' },
              { id: '6', title: 'Store six' },
              { id: '7', title: 'Store seven' },
              { id: '8', title: 'Store eight' },
              { id: '9', title: 'Store nine' },
            ],
          },
          (item) => h(DataCard, { as: 'article' }, item.title),
        ),
        h(
          FullscreenShell,
          { title: 'Menu browser', toolbar: h(ExpandButton, null, 'Expand') },
          h('section', null, 'Detailed menu'),
        ),
      );
    }

    render(h(Probe));
    expect(document.querySelector('.nsr-inline-card')?.textContent).toContain('Order ready');
    expect(document.querySelectorAll('.nsr-inline-card .nsr-actions button')).toHaveLength(2);
    expect(document.querySelectorAll('.nsr-inline-carousel > *')).toHaveLength(8);
    expect(document.querySelector('.nsr-fullscreen-shell')?.textContent).toContain('Menu browser');

    await act(async () => {
      Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent === 'Expand')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(bridge.calls.find((entry) => entry.method === 'requestDisplayMode')?.args).toBe(
      'fullscreen',
    );
  });

  it('renders minimal semantic composition primitives for generated apps', async () => {
    function Probe() {
      return h(
        Frame,
        {
          title: 'Sales workspace',
          subtitle: 'Host-native synthetic operations view',
          status: h(StatusBadge, { tone: 'info' }, 'Ready'),
          actions: h(Action, { variant: 'primary' }, 'Review'),
          footer: 'Updated now',
        },
        h(
          Flow,
          { variant: 'sidebar' },
          h(
            Region,
            {
              title: 'Accounts',
              description: 'Select one workspace',
              actions: h(Action, { variant: 'quiet' }, 'Refresh'),
            },
            h(
              Collection,
              { variant: 'list', selectionMode: 'single' },
              h(
                Collection.Item,
                { selected: true, title: 'Atlas Solar', meta: '$126,000' },
                'CRM gaps',
              ),
            ),
          ),
          h(
            Flow,
            { variant: 'stack' },
            h(Fact, { label: 'Close rate', value: '+23%', detail: 'Illustrative' }),
            h(Fact, { label: 'Admin time', value: '-41%', tone: 'success' }),
          ),
        ),
      );
    }

    render(h(Probe));
    expect(document.querySelector('.nsr-frame')?.textContent).toContain('Sales workspace');
    expect(document.querySelector('.nsr-flow-sidebar')?.textContent).toContain('Accounts');
    expect(document.querySelector('.nsr-region')?.textContent).toContain('Select one workspace');
    expect(
      document.querySelector('.nsr-collection-item[data-selected="true"]')?.textContent,
    ).toContain('Atlas Solar');
    expect(document.querySelector('.nsr-fact')?.textContent).toContain('+23%');
    expect(document.querySelector('.nsr-action-primary')?.textContent).toBe('Review');
  });

  it('renders field, feedback, overlay, and polished view navigation primitives', () => {
    function Probe() {
      return h(
        Frame,
        { title: 'Primitive coverage' },
        h(ViewNav, {
          activeView: 'details',
          items: [
            { view: 'summary', label: 'Summary' },
            { view: 'details', label: 'Details' },
          ],
          onNavigate: () => undefined,
          variant: 'tabs',
        }),
        h(
          Field,
          {
            label: 'Account',
            detail: 'Choose a workspace',
            error: 'Required',
            required: true,
          },
          h('input', { 'aria-label': 'account' }),
        ),
        h(Feedback, {
          status: 'permission-denied',
          title: 'Permission needed',
          description: 'Connect this app before continuing.',
          action: h(Action, { variant: 'primary' }, 'Connect'),
        }),
        h(
          Overlay,
          {
            open: true,
            mode: 'sheet',
            title: 'Inspect record',
            description: 'Synthetic details',
            actions: h(Action, { variant: 'quiet' }, 'Close'),
          },
          'Record body',
        ),
      );
    }

    render(h(Probe));
    expect(document.querySelector('.nsr-view-nav-tabs')?.textContent).toContain('Details');
    expect(document.querySelector('.nsr-view-nav-item[aria-current="page"]')?.textContent).toBe(
      'Details',
    );
    expect(document.querySelector('.nsr-field')?.textContent).toContain('Required');
    expect(document.querySelector('.nsr-field input')?.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.nsr-feedback-permission-denied')?.textContent).toContain(
      'Permission needed',
    );
    expect(document.querySelector('.nsr-overlay-sheet[role="dialog"]')?.textContent).toContain(
      'Inspect record',
    );
  });
});

describe('form-control atoms', () => {
  it('renders Input / Textarea / Select with nsr- classes, values, and invalid state', () => {
    render(
      h(
        'div',
        null,
        h(Input, { value: 'Priya', 'aria-label': 'name', readOnly: true }),
        h(Textarea, { value: 'notes', invalid: true, 'aria-label': 'notes', readOnly: true }),
        h(Select, {
          value: 'm',
          'aria-label': 'size',
          placeholder: 'Pick one',
          options: [
            { value: 's', label: 'Small' },
            { value: 'm', label: 'Medium' },
          ],
        }),
      ),
    );

    const input = document.querySelector('input.nsr-input') as HTMLInputElement | null;
    expect(input?.value).toBe('Priya');
    expect(input?.getAttribute('aria-invalid')).toBeNull();

    const textarea = document.querySelector('textarea.nsr-textarea') as HTMLTextAreaElement | null;
    expect(textarea?.value).toBe('notes');
    expect(textarea?.getAttribute('aria-invalid')).toBe('true');

    const select = document.querySelector('select.nsr-select') as HTMLSelectElement | null;
    expect(select?.value).toBe('m');
    // placeholder + 2 real options
    expect(select?.querySelectorAll('option').length).toBe(3);
    expect(select?.querySelector('option[value="m"]')?.textContent).toBe('Medium');
  });

  it('renders Checkbox / RadioGroup / Switch / Slider and fires change handlers', () => {
    const events: string[] = [];
    render(
      h(
        'div',
        null,
        h(Checkbox, {
          checked: true,
          readOnly: true,
          label: 'Agree',
          onCheckedChange: (v) => events.push(`cb:${v}`),
        }),
        h(RadioGroup, {
          value: 'a',
          'aria-label': 'choice',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
          onValueChange: (v) => events.push(`radio:${v}`),
        }),
        h(Switch, { checked: false, label: 'On', onCheckedChange: (v) => events.push(`sw:${v}`) }),
        h(Slider, { min: 0, max: 10, value: 5, readOnly: true, 'aria-label': 'level' }),
      ),
    );

    expect((document.querySelector('input.nsr-checkbox') as HTMLInputElement).checked).toBe(true);
    const radios = document.querySelectorAll('.nsr-radio input');
    expect(radios.length).toBe(2);
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    const sw = document.querySelector('.nsr-switch') as HTMLInputElement;
    expect(sw.type).toBe('checkbox');
    expect(sw.checked).toBe(false);
    const slider = document.querySelector('input.nsr-slider') as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.value).toBe('5');

    act(() => sw.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() =>
      (radios[1] as HTMLInputElement).dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(events).toContain('sw:true');
    expect(events).toContain('radio:b');
  });
});

function render(node: ReactNode): void {
  root = createRoot(
    document.querySelector('#root') ?? document.body.appendChild(document.createElement('div')),
  );
  act(() => root?.render(node));
}

function bump(): void {
  const globals = globalThis as { __noodleReactVersion?: number };
  globals.__noodleReactVersion = (globals.__noodleReactVersion ?? 0) + 1;
  globalThis.dispatchEvent(new CustomEvent('noodle:state'));
}

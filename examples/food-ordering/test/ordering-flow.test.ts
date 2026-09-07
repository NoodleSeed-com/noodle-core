// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import OrderingFlow from '../src/views/ordering-flow.js';

vi.mock('../src/helpers.js', async () => {
  const { createElement } = await import('react');
  const container = ({ children }: { readonly children?: unknown }) =>
    createElement('div', null, children);
  const button = ({ children }: { readonly children?: unknown }) =>
    createElement('button', { type: 'button' }, children);
  return {
    ActionBar: container,
    AppShell: ({
      children,
      footer,
      subtitle,
      title,
    }: {
      readonly children?: unknown;
      readonly footer?: unknown;
      readonly subtitle?: string;
      readonly title?: string;
    }) => createElement('main', null, title, subtitle, children, footer),
    AsyncBoundary: container,
    ChoiceGroup: container,
    createViewStore:
      <T>(_key: string, initial: T) =>
      (selector?: (state: T) => unknown) => ({
        state: initial,
        selected: selector?.(initial),
        setState: () => undefined,
      }),
    DataCard: button,
    DataList: container,
    Feedback: ({ children, status }: { readonly children?: unknown; readonly status?: string }) =>
      createElement('div', { 'data-status': status }, children),
    Field: container,
    Form: ({ children }: { readonly children?: unknown }) => createElement('form', null, children),
    HandoffButton: button,
    QuantityStepper: container,
    ShellNav: container,
    StatusBadge: container,
    SubmitButton: button,
    useAppFlow: () => ({
      activeView: 'stores',
      navigate: () => undefined,
      back: () => undefined,
      canBack: false,
      params: {},
    }),
    useCallTool: () => ({
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      callTool: () => Promise.resolve({ structuredContent: {} }),
      callToolAsync: () => Promise.resolve({ structuredContent: {} }),
      reset: () => undefined,
    }),
    useHandoff: () => ({ status: 'idle', open: () => Promise.resolve() }),
    useLayout: () => ({
      theme: 'light',
      displayMode: 'inline',
      supports: { modelContext: false, followUpMessage: false },
    }),
    useSendFollowUpMessage: () => () => Promise.resolve(),
    useToolInfo: () => toolResult,
    useUpdateModelContext: () => () => Promise.resolve(),
    useViewState: <T>(_key: string, initial: T) => [initial, () => undefined] as const,
    useWidgetLifecycle: () => () => Promise.resolve(),
    useWidgetReady: () => true,
    View: container,
    ViewStack: container,
  };
});

type ToolResult = {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly _meta?: unknown;
  readonly isError?: boolean;
};

let toolResult: ToolResult;
let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toolResult = {};
  document.body.innerHTML = '<div id="root"></div>';
  (globalThis as { __noodleReactVersion?: number }).__noodleReactVersion = 0;
  (globalThis as { __noodleReactBridge?: unknown }).__noodleReactBridge = {
    getToolResult: () => toolResult,
    getViewState: () => ({}),
    setWidgetState: () => undefined,
    getLayout: () => ({
      theme: 'light',
      displayMode: 'inline',
      supports: { modelContext: false, followUpMessage: false },
    }),
    callServerTool: () => Promise.resolve({ structuredContent: {} }),
    openExternal: () => Promise.resolve(),
    sendFollowUpMessage: () => Promise.resolve(),
    updateModelContext: () => Promise.resolve(),
  };
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  delete (globalThis as { __noodleReactBridge?: unknown }).__noodleReactBridge;
});

function render(result: ToolResult): string {
  toolResult = result;
  root = createRoot(document.querySelector('#root') as HTMLElement);
  act(() => root?.render(h(OrderingFlow)));
  return document.body.textContent ?? '';
}

describe('food-ordering invoking result states', () => {
  it('renders pending without identifier-dependent actions before hydration', () => {
    const text = render({});
    expect(text).toContain('Loading food ordering');
    expect(text).not.toContain('Search stores');
    expect(document.querySelector('button')).toBeNull();
  });

  it('renders an explicit tool error without ordering actions', () => {
    const text = render({
      content: [{ type: 'text', text: 'Ordering is unavailable' }],
      isError: true,
    });
    expect(text).toContain('Could not load food ordering');
    expect(text).not.toContain('Search stores');
    expect(document.querySelector('button')).toBeNull();
  });

  it('rejects malformed success data before rendering identifier-dependent actions', () => {
    const text = render({
      structuredContent: {
        status: 'Ready',
        customer: 'Asha',
        stores: [{ name: 'Missing identifier' }],
        featuredItems: [],
      },
    });
    expect(text).toContain('Food ordering result was incomplete');
    expect(text).not.toContain('Search stores');
    expect(document.querySelector('button')).toBeNull();
  });

  it('preserves the ordering flow after valid hydration', () => {
    const text = render({
      structuredContent: {
        status: 'Ready to build a food order.',
        customer: 'Asha',
        stores: [
          {
            id: 'harbor-noodles',
            name: 'Harbor Noodles',
            cuisine: 'Noodles',
            address: '18 Pier Lane',
            open: true,
            etaMinutes: 24,
            rating: 4.8,
          },
        ],
        featuredItems: [
          {
            id: 'spicy_miso',
            storeId: 'harbor-noodles',
            category: 'Bowls',
            name: 'Spicy Miso Bowl',
            price: 16,
            description: 'Miso broth and noodles.',
            modifiers: ['extra_noodles'],
          },
        ],
      },
    });
    expect(text).toContain('Search stores');
    expect(text).toContain('Harbor Noodles');
    expect(document.querySelector('form')).not.toBeNull();
  });
});

// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, Overlay, Popover, Tooltip } from '../src/react.js';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (root) act(() => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  root = undefined;
});

describe('React overlay production contracts', () => {
  it('puts tooltip description semantics on the actual trigger and dismisses on Escape', () => {
    render(h(Tooltip, { content: 'Copy link' }, h('button', { type: 'button' }, 'Copy')));
    const trigger = document.querySelector<HTMLButtonElement>('button');

    act(() => trigger?.focus());
    const tooltip = document.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(trigger?.getAttribute('aria-describedby')).toContain(tooltip?.id);

    act(() =>
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('names a Popover from its trigger and closes on Escape', async () => {
    render(
      h(
        Popover,
        { trigger: 'Details', triggerLabel: 'Show account details' },
        h('button', { type: 'button' }, 'Inside'),
      ),
    );
    const trigger = document.querySelector<HTMLButtonElement>('.nsr-popover-trigger');
    act(() => {
      trigger?.focus();
      trigger?.click();
    });
    const panel = document.querySelector<HTMLElement>('.nsr-popover-panel');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    expect(panel?.getAttribute('role')).toBe('dialog');
    expect(panel?.getAttribute('aria-labelledby')).toBe(trigger?.id);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.querySelector('.nsr-popover-panel')).toBeNull();
  });

  it('implements Menu as a real menu with keyboard focus and disabled-item semantics', async () => {
    const picked = vi.fn();
    render(
      h(Menu, {
        trigger: 'Actions',
        triggerLabel: 'Open actions',
        items: [
          { label: 'Rename', textValue: 'Rename', onSelect: picked },
          { label: 'Archive', textValue: 'Archive', disabled: true },
          { label: 'Delete', textValue: 'Delete', danger: true },
        ],
      }),
    );
    const trigger = document.querySelector<HTMLButtonElement>('.nsr-menu-trigger');
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');

    act(() => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
    expect(menu).not.toBeNull();
    expect(items).toHaveLength(3);
    expect(items[1]?.hasAttribute('data-disabled')).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    await act(async () => {
      items[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(picked).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('gives modal Overlay a name and reports Escape through onOpenChange', () => {
    const onOpenChange = vi.fn();
    render(
      h(
        Overlay,
        { open: true, onOpenChange, mode: 'modal', title: 'Confirm deletion' },
        h('button', { type: 'button' }, 'Delete'),
      ),
    );
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const titleId = dialog?.getAttribute('aria-labelledby');
    expect(titleId).toBeTruthy();
    expect(document.getElementById(titleId ?? '')?.textContent).toBe('Confirm deletion');
    expect(dialog?.getAttribute('aria-modal')).toBe('true');

    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders detail Overlay as a named region rather than a false dialog', () => {
    render(h(Overlay, { open: true, mode: 'detail', title: 'Record details' }, 'Body'));
    const detail = document.querySelector<HTMLElement>('.nsr-overlay-detail');
    expect(detail?.getAttribute('role')).toBe('region');
    expect(detail?.hasAttribute('aria-modal')).toBe(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const titleId = detail?.getAttribute('aria-labelledby');
    expect(document.getElementById(titleId ?? '')?.textContent).toBe('Record details');
  });
});

function render(node: ReactNode): Root {
  const container = document.getElementById('root');
  if (!container) throw new Error('missing test root');
  root = createRoot(container);
  act(() => root?.render(node));
  return root;
}

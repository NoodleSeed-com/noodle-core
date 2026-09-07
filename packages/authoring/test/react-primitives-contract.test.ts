// @vitest-environment happy-dom
/// <reference lib="dom" />
import { act, createRef, type FormEvent, createElement as h, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  Avatar,
  AvatarGroup,
  Checkbox,
  Collection,
  ExpandButton,
  Fact,
  Feedback,
  Field,
  Form,
  Input,
  RadioGroup,
  Region,
  SegmentedControl,
  Spinner,
  SubmitButton,
  Switch,
} from '../src/react.js';

let root: Root | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (root) act(() => root?.unmount());
  document.body.innerHTML = '<div id="root"></div>';
  root = undefined;
});

describe('React primitive production contracts', () => {
  it('captures submit-control clicks before native form submission', () => {
    const submit = vi.fn();
    const controlClick = vi.fn();
    render(
      h(
        Form,
        { onSubmit: submit },
        h(Input, { name: 'title', defaultValue: 'Plumbing job', required: true }),
        h(SubmitButton, { onClick: controlClick }, 'Save'),
      ),
    );

    const button = document.querySelector<HTMLButtonElement>('button');
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    let accepted = true;
    act(() => {
      accepted = button?.dispatchEvent(event) ?? true;
    });

    expect(accepted).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(controlClick).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('captures plain Enter from a single-line input but not a textarea', () => {
    const submit = vi.fn();
    render(
      h(
        Form,
        { onSubmit: submit },
        h(Input, { name: 'title', defaultValue: 'Plumbing job' }),
        h('textarea', { name: 'notes', defaultValue: 'Keep this multiline' }),
        h(SubmitButton, null, 'Save'),
      ),
    );

    const input = document.querySelector('input');
    const textarea = document.querySelector('textarea');
    const inputEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const textareaEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    const modifiedInputEvent = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => {
      input?.dispatchEvent(inputEvent);
      textarea?.dispatchEvent(textareaEvent);
      input?.dispatchEvent(modifiedInputEvent);
    });

    expect(inputEvent.defaultPrevented).toBe(true);
    expect(textareaEvent.defaultPrevented).toBe(false);
    expect(modifiedInputEvent.defaultPrevented).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('applies local constraint validation before accepting intent', () => {
    const submit = vi.fn();
    const rendered = render(
      h(
        Form,
        { onSubmit: submit },
        h(Input, { name: 'title', required: true }),
        h(SubmitButton, null, 'Save'),
      ),
    );

    act(() => document.querySelector<HTMLButtonElement>('button')?.click());
    expect(submit).not.toHaveBeenCalled();

    act(() =>
      rendered.render(
        h(
          Form,
          { onSubmit: submit, noValidate: true },
          h(Input, { name: 'title', required: true }),
          h(SubmitButton, null, 'Save without validation'),
        ),
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('button')?.click());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('respects submitter formNoValidate and caller-cancelled clicks', () => {
    const submit = vi.fn();
    const rendered = render(
      h(
        Form,
        { onSubmit: submit },
        h(Input, { name: 'title', required: true }),
        h(SubmitButton, { formNoValidate: true }, 'Save draft'),
      ),
    );

    act(() => document.querySelector<HTMLButtonElement>('button')?.click());
    expect(submit).toHaveBeenCalledTimes(1);

    submit.mockClear();
    act(() =>
      rendered.render(
        h(
          Form,
          { onSubmit: submit },
          h(Input, { name: 'title', defaultValue: 'Plumbing job' }),
          h(SubmitButton, { onClick: (event) => event.preventDefault() }, 'Save'),
        ),
      ),
    );
    act(() => document.querySelector<HTMLButtonElement>('button')?.click());
    expect(submit).not.toHaveBeenCalled();
  });

  it('cancels a native submit event as a defensive fallback', () => {
    const submit = vi.fn();
    render(h(Form, { onSubmit: submit }, h(SubmitButton, null, 'Save')));

    const form = document.querySelector<HTMLFormElement>('form');
    const event = new SubmitEvent('submit', { bubbles: true, cancelable: true });
    let accepted = true;
    act(() => {
      accepted = form?.dispatchEvent(event) ?? true;
    });

    expect(accepted).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(form?.hasAttribute('action')).toBe(false);
    expect(form?.hasAttribute('method')).toBe(false);
    expect(form?.hasAttribute('target')).toBe(false);
  });

  it('associates Field labels, detail, errors, and required state with the actual control', () => {
    render(
      h(
        Field,
        {
          label: 'Email',
          detail: 'We only use this for receipts.',
          error: 'Enter a valid email.',
          required: true,
        },
        h(Input, { name: 'email', 'aria-describedby': 'external-help' }),
      ),
    );

    const input = document.querySelector('input');
    const label = document.querySelector('.nsr-field-label');
    const detail = document.querySelector('.nsr-field-detail');
    const error = document.querySelector('.nsr-field-error');

    expect(input?.id).not.toBe('');
    expect(label?.getAttribute('for')).toBe(input?.id);
    expect(input?.required).toBe(true);
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(input?.getAttribute('aria-describedby')?.split(' ')).toEqual(
      expect.arrayContaining(['external-help', detail?.id]),
    );
    expect(input?.getAttribute('aria-errormessage')).toBe(error?.id);
    expect(document.querySelector('label label')).toBeNull();
  });

  it('preserves caller ARIA and forwards a ref through Input', () => {
    const ref = createRef<HTMLInputElement>();
    render(h(Input, { ref, 'aria-invalid': 'spelling', 'aria-describedby': 'custom-help' }));

    expect(ref.current).toBe(document.querySelector('input'));
    expect(ref.current?.getAttribute('aria-invalid')).toBe('spelling');
    expect(ref.current?.getAttribute('aria-describedby')).toBe('custom-help');
  });

  it('keeps grouped checkbox ids and required semantics on the group, not every item', () => {
    render(
      h(
        Field,
        { label: 'Channels', detail: 'Choose at least one.', group: true, required: true },
        h(
          'div',
          null,
          h(Checkbox, { label: 'Email', name: 'channels', value: 'email' }),
          h(Checkbox, { label: 'SMS', name: 'channels', value: 'sms' }),
        ),
      ),
    );

    const fieldset = document.querySelector('fieldset');
    const checkboxes = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    );
    expect(fieldset?.getAttribute('aria-required')).toBe('true');
    expect(checkboxes.map((control) => control.id).filter(Boolean)).toEqual([]);
    expect(checkboxes.every((control) => !control.required)).toBe(true);
  });

  it('supports uncontrolled RadioGroup state with a default value', () => {
    const changes: string[] = [];
    render(
      h(RadioGroup, {
        options: [
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ],
        defaultValue: 'daily',
        onValueChange: (value: string) => changes.push(value),
        'aria-label': 'Cadence',
      }),
    );

    const radios = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
    expect(radios[0]?.checked).toBe(true);
    act(() => radios[1]?.click());
    expect(radios[1]?.checked).toBe(true);
    expect(changes).toEqual(['weekly']);
  });

  it('uses a native checkbox-backed Switch with form and reset semantics', () => {
    const changes: boolean[] = [];
    render(
      h(
        'form',
        null,
        h(Switch, {
          name: 'alerts',
          value: 'enabled',
          defaultChecked: true,
          label: 'Alerts',
          onCheckedChange: (checked: boolean) => changes.push(checked),
        }),
      ),
    );

    const form = document.querySelector('form');
    const control = document.querySelector<HTMLInputElement>('input[role="switch"]');
    expect(control?.type).toBe('checkbox');
    expect(control?.checked).toBe(true);
    expect(new FormData(form ?? undefined).get('alerts')).toBe('enabled');

    act(() => control?.click());
    expect(control?.checked).toBe(false);
    expect(changes).toEqual([false]);

    act(() => form?.reset());
    expect(control?.checked).toBe(true);
  });

  it('uses native radios for an uncontrolled SegmentedControl', () => {
    const changes: string[] = [];
    render(
      h(SegmentedControl, {
        options: [
          { value: 'list', label: 'List' },
          { value: 'grid', label: 'Grid' },
        ],
        defaultValue: 'list',
        onValueChange: (value: string) => changes.push(value),
        name: 'layout',
        'aria-label': 'Layout',
      }),
    );

    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('.nsr-segmented input[type="radio"]'),
    );
    expect(radios).toHaveLength(2);
    expect(radios[0]?.checked).toBe(true);
    act(() => radios[1]?.click());
    expect(radios[1]?.checked).toBe(true);
    expect(changes).toEqual(['grid']);
  });

  it('submits by default from SubmitButton', () => {
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(h('form', { onSubmit: submit }, h(SubmitButton, null, 'Save')));

    const button = document.querySelector<HTMLButtonElement>('button');
    expect(button?.type).toBe('submit');
    act(() => button?.click());
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('keeps ExpandButton a standalone action even when composed inside a form', () => {
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(h('form', { onSubmit: submit }, h(ExpandButton, null, 'Expand')));

    const button = document.querySelector<HTMLButtonElement>('button');
    expect(button?.type).toBe('button');
    act(() => button?.click());
    expect(submit).not.toHaveBeenCalled();
  });

  it('uses valid standalone semantics for facts and visual collection selection', () => {
    render(
      h(
        'div',
        null,
        h(Fact, { label: 'Latency', value: '42 ms' }),
        h(Collection.Item, { selected: true, title: 'Selected item' }),
      ),
    );

    expect(document.querySelector('.nsr-fact')?.tagName).toBe('DL');
    expect(document.querySelector('.nsr-fact > dt')).not.toBeNull();
    expect(document.querySelector('.nsr-fact > dd')).not.toBeNull();
    const item = document.querySelector('.nsr-collection-item');
    expect(item?.getAttribute('data-selected')).toBe('true');
    expect(item?.hasAttribute('aria-selected')).toBe(false);
  });

  it('names Region from its heading and marks loading feedback busy', () => {
    render(
      h(
        Region,
        { title: 'Account settings' },
        h(Feedback, { status: 'loading', description: 'Loading account' }),
      ),
    );
    const region = document.querySelector<HTMLElement>('.nsr-region');
    const headingId = region?.getAttribute('aria-labelledby');
    expect(headingId).toBeTruthy();
    expect(document.getElementById(headingId ?? '')?.textContent).toBe('Account settings');
    expect(document.querySelector('.nsr-feedback')?.getAttribute('aria-busy')).toBe('true');
  });

  it('makes disabled anchor Actions non-activatable', () => {
    const onClick = vi.fn();
    render(
      h(Action, { as: 'a', href: 'https://example.com', disabled: true, onClick }, 'Continue'),
    );

    const link = document.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('aria-disabled')).toBe('true');
    expect(link?.hasAttribute('href')).toBe(false);
    act(() => link?.click());
    expect(onClick).not.toHaveBeenCalled();
  });

  it('falls back to initials when an Avatar image fails', () => {
    render(h(Avatar, { src: '/missing.png', name: 'Ada Lovelace', size: 40 }));
    const image = document.querySelector('img');
    act(() => image?.dispatchEvent(new Event('error')));

    const fallback = document.querySelector<HTMLElement>('.nsr-avatar-fallback');
    expect(fallback?.textContent).toBe('AL');
    expect(fallback?.style.width).toBe('40px');
    expect(fallback?.style.height).toBe('40px');
  });

  it('sizes AvatarGroup overflow from the visible avatars', () => {
    render(
      h(
        AvatarGroup,
        { max: 1 },
        h(Avatar, { name: 'Ada Lovelace', size: 40 }),
        h(Avatar, { name: 'Grace Hopper', size: 40 }),
      ),
    );
    const overflow = document.querySelector<HTMLElement>('.nsr-avatar-more');
    expect(overflow?.textContent).toBe('+1');
    expect(overflow?.style.width).toBe('40px');
    expect(overflow?.style.height).toBe('40px');
  });

  it('exposes Spinner as a named status and respects its size', () => {
    render(h(Spinner, { size: 24, label: 'Fetching' }));
    const spinner = document.querySelector<HTMLElement>('.nsr-spinner');
    expect(spinner?.getAttribute('role')).toBe('status');
    expect(spinner?.getAttribute('aria-label')).toBe('Fetching');
    expect(spinner?.style.width).toBe('24px');
  });
});

function render(node: ReactNode): Root {
  const container = document.getElementById('root');
  if (!container) throw new Error('missing test root');
  root = createRoot(container);
  act(() => root?.render(node));
  return root;
}

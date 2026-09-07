// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantJsonValue } from '../src/client.js';
import { createInputRequestCard } from '../src/input-request-card.js';

afterEach(() => {
  document.body.replaceChildren();
});

describe('elicitation input request card', () => {
  it('omits untouched optional booleans and arrays while preserving required presence', async () => {
    const { form, respond } = render({
      type: 'object',
      properties: {
        optionalBoolean: { type: 'boolean' },
        optionalArray: { type: 'array', items: { type: 'string', enum: ['one', 'two'] } },
        optionalBoundedArray: {
          type: 'array',
          items: { type: 'string', enum: ['one', 'two'] },
          minItems: 1,
        },
        requiredBoolean: { type: 'boolean' },
        requiredArray: { type: 'array', items: { type: 'string', enum: ['one', 'two'] } },
        requiredText: { type: 'string' },
      },
      required: ['requiredBoolean', 'requiredArray', 'requiredText'],
    });

    expect(form.elements.namedItem('requiredText')).toMatchObject({ required: false });
    submit(form);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(acceptedContent(respond)).toEqual({
      requiredBoolean: false,
      requiredArray: [],
      requiredText: '',
    });
  });

  it('preserves false and empty defaults plus deliberately cleared optional values', async () => {
    const { form, respond } = render({
      type: 'object',
      properties: {
        defaultFalse: { type: 'boolean', default: false },
        defaultEmpty: {
          type: 'array',
          items: { type: 'string', enum: ['one', 'two'] },
          default: [],
        },
        explicitFalse: { type: 'boolean' },
        explicitEmpty: { type: 'array', items: { type: 'string', enum: ['one', 'two'] } },
      },
    });
    const explicitFalse = input(form, 'explicitFalse');
    const explicitEmpty = select(form, 'explicitEmpty');

    explicitFalse.checked = true;
    explicitFalse.dispatchEvent(new Event('change', { bubbles: true }));
    explicitFalse.checked = false;
    explicitFalse.dispatchEvent(new Event('change', { bubbles: true }));
    // A change event is the renderer's durable signal that the user deliberately left the array empty.
    explicitEmpty.dispatchEvent(new Event('change', { bubbles: true }));
    submit(form);

    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(acceptedContent(respond)).toEqual({
      defaultFalse: false,
      defaultEmpty: [],
      explicitFalse: false,
      explicitEmpty: [],
    });
  });

  it('leaves a required single-select unchosen unless the schema supplies a default', async () => {
    const first = render({
      type: 'object',
      properties: {
        team: { type: 'string', enum: ['noodle', 'platform'] },
      },
      required: ['team'],
    });
    const team = select(first.form, 'team');

    expect(team.selectedOptions[0]?.dataset.placeholder).toBe('true');
    expect(team.value).not.toBe('noodle');
    expect(team.checkValidity()).toBe(false);
    submit(first.form);
    expect(first.respond).not.toHaveBeenCalled();

    team.value = 'platform';
    team.dispatchEvent(new Event('change', { bubbles: true }));
    submit(first.form);
    await vi.waitFor(() => expect(first.respond).toHaveBeenCalledOnce());
    expect(acceptedContent(first.respond)).toEqual({ team: 'platform' });

    const second = render({
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['pickup', 'delivery'], default: 'delivery' },
      },
      required: ['method'],
    });
    expect(select(second.form, 'method').value).toBe('delivery');
    submit(second.form);
    await vi.waitFor(() => expect(second.respond).toHaveBeenCalledOnce());
    expect(acceptedContent(second.respond)).toEqual({ method: 'delivery' });
  });

  it('enforces multi-select minItems and maxItems only when the array is present', async () => {
    const { form, respond } = render({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string', enum: ['one', 'two', 'three'] },
          minItems: 2,
          maxItems: 2,
        },
      },
      required: ['tags'],
    });
    const tags = select(form, 'tags');

    optionAt(tags, 0).selected = true;
    tags.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tags.validationMessage).toContain('at least 2');
    submit(form);
    expect(respond).not.toHaveBeenCalled();

    optionAt(tags, 1).selected = true;
    optionAt(tags, 2).selected = true;
    tags.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tags.validationMessage).toContain('at most 2');
    submit(form);
    expect(respond).not.toHaveBeenCalled();

    optionAt(tags, 2).selected = false;
    tags.dispatchEvent(new Event('change', { bubbles: true }));
    expect(tags.checkValidity()).toBe(true);
    submit(form);
    await vi.waitFor(() => expect(respond).toHaveBeenCalledOnce());
    expect(acceptedContent(respond)).toEqual({ tags: ['one', 'two'] });
  });
});

function render(requestedSchema: Readonly<Record<string, unknown>>): {
  readonly form: HTMLFormElement;
  readonly respond: ReturnType<typeof vi.fn>;
} {
  const respond = vi.fn(async () => {});
  const card = createInputRequestCard({
    message: 'Complete the details',
    requestedSchema,
    labels: { submit: 'Submit', decline: 'Decline', cancel: 'Cancel' },
    respond,
  });
  document.body.append(card);
  const form = card.querySelector('form');
  if (!form) throw new Error('input request form was not rendered');
  return { form, respond };
}

function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function input(form: HTMLFormElement, name: string): HTMLInputElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLInputElement)) throw new Error(`missing input ${name}`);
  return control;
}

function select(form: HTMLFormElement, name: string): HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLSelectElement)) throw new Error(`missing select ${name}`);
  return control;
}

function optionAt(select: HTMLSelectElement, index: number): HTMLOptionElement {
  const item = select.options.item(index);
  if (!item) throw new Error(`missing option ${index}`);
  return item;
}

function acceptedContent(respond: ReturnType<typeof vi.fn>): AssistantJsonValue | undefined {
  const response = respond.mock.calls[0]?.[0] as
    | { readonly action: 'accept'; readonly content: AssistantJsonValue }
    | undefined;
  return response?.content;
}

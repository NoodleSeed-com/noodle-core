import type { AssistantJsonValue } from './client.js';

interface InputRequestCardOptions {
  readonly message: string;
  readonly requestedSchema: Readonly<Record<string, unknown>>;
  readonly labels: {
    readonly submit: string;
    readonly decline: string;
    readonly cancel: string;
  };
  readonly respond: (
    response:
      | { readonly action: 'accept'; readonly content: AssistantJsonValue }
      | { readonly action: 'decline' | 'cancel' },
  ) => Promise<void>;
}

/** Render the portable MCP form-elicitation subset without interpreting author HTML. */
export function createInputRequestCard(options: InputRequestCardOptions): HTMLElement {
  const card = document.createElement('section');
  card.className = 'tool-proposal input-request';
  card.dataset.kind = 'input';
  const form = document.createElement('form');
  const heading = document.createElement('strong');
  heading.textContent = options.message;
  form.append(heading);

  const properties = record(options.requestedSchema.properties);
  const required = new Set(
    Array.isArray(options.requestedSchema.required)
      ? options.requestedSchema.required.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const touched = new WeakSet<HTMLInputElement | HTMLSelectElement>();
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = record(rawProperty);
    const label = document.createElement('label');
    const caption = document.createElement('span');
    caption.textContent =
      typeof property.title === 'string' && property.title ? property.title : humanize(name);
    const control = createControl(name, property, required.has(name));
    const markTouched = (): void => {
      touched.add(control);
      updateControlValidity(control, property, required.has(name), touched.has(control));
    };
    control.addEventListener('input', markTouched);
    control.addEventListener('change', markTouched);
    label.append(caption, control);
    form.append(label);
    controls.set(name, control);
  }

  const actions = document.createElement('div');
  actions.className = 'proposal-actions';
  const submit = button(options.labels.submit, 'submit');
  const decline = button(options.labels.decline, 'button');
  const cancel = button(options.labels.cancel, 'button');
  const buttons = [submit, decline, cancel];
  const resolve = async (
    response:
      | { readonly action: 'accept'; readonly content: AssistantJsonValue }
      | { readonly action: 'decline' | 'cancel' },
  ): Promise<void> => {
    buttons.forEach((item) => {
      item.disabled = true;
    });
    try {
      await options.respond(response);
    } catch (error) {
      buttons.forEach((item) => {
        item.disabled = false;
      });
      throw error;
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    for (const [name, control] of controls) {
      updateControlValidity(
        control,
        record(properties[name]),
        required.has(name),
        touched.has(control),
      );
    }
    if (!form.reportValidity()) return;
    void resolve({
      action: 'accept',
      content: readContent(controls, properties, required, touched),
    }).catch(() => {});
  });
  decline.addEventListener('click', () => {
    void resolve({ action: 'decline' }).catch(() => {});
  });
  cancel.addEventListener('click', () => {
    void resolve({ action: 'cancel' }).catch(() => {});
  });
  actions.append(submit, decline, cancel);
  form.append(actions);
  card.append(form);
  return card;
}

function createControl(
  name: string,
  property: Readonly<Record<string, unknown>>,
  required: boolean,
): HTMLInputElement | HTMLSelectElement {
  const choices = stringChoices(property);
  if (choices || property.type === 'array') {
    const select = document.createElement('select');
    select.name = name;
    select.multiple = property.type === 'array';
    const availableChoices = choices ?? arrayChoices(property);
    if (
      !select.multiple &&
      (!required || !availableChoices.some((choice) => choice.value === property.default))
    ) {
      select.append(placeholderOption(availableChoices));
    }
    for (const choice of availableChoices) {
      select.append(option(choice.title, choice.value));
    }
    applySelectDefault(select, property.default);
    updateControlValidity(select, property, required, false);
    return select;
  }
  const input = document.createElement('input');
  input.name = name;
  input.type = inputType(property);
  // JSON Schema `required` means property presence. An empty string and `false` remain present values,
  // while an empty number/date control has no representable JSON value.
  input.required = required && inputNeedsNonEmptyValue(property);
  if (property.type === 'integer') input.step = '1';
  if (typeof property.minimum === 'number') input.min = String(property.minimum);
  if (typeof property.maximum === 'number') input.max = String(property.maximum);
  if (typeof property.minLength === 'number') input.minLength = property.minLength;
  if (typeof property.maxLength === 'number') input.maxLength = property.maxLength;
  if (property.format === 'date-time') input.step = '0.001';
  applyInputDefault(input, property);
  return input;
}

function readContent(
  controls: ReadonlyMap<string, HTMLInputElement | HTMLSelectElement>,
  properties: Readonly<Record<string, unknown>>,
  required: ReadonlySet<string>,
  touched: Readonly<WeakSet<HTMLInputElement | HTMLSelectElement>>,
): AssistantJsonValue {
  const content: Record<string, AssistantJsonValue> = {};
  for (const [name, control] of controls) {
    const property = record(properties[name]);
    if (control instanceof HTMLSelectElement && control.multiple) {
      const values = [...control.selectedOptions].map((option) => option.value);
      if (shouldIncludeArray(property, required.has(name), touched.has(control), values.length)) {
        content[name] = values;
      }
    } else if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      if (required.has(name) || hasDefault(property) || touched.has(control)) {
        content[name] = control.checked;
      }
    } else if (control instanceof HTMLSelectElement) {
      if (!isPlaceholderSelected(control)) content[name] = control.value;
    } else if (
      control.value !== '' ||
      (property.type === 'string' &&
        (required.has(name) || hasDefault(property) || touched.has(control)))
    ) {
      if (property.format === 'date-time') {
        const value = dateTimeLocalToRfc3339(control.value);
        if (value !== undefined) content[name] = value;
      } else {
        content[name] =
          property.type === 'number' || property.type === 'integer'
            ? Number(control.value)
            : control.value;
      }
    }
  }
  return content;
}

function updateControlValidity(
  control: HTMLInputElement | HTMLSelectElement,
  property: Readonly<Record<string, unknown>>,
  required: boolean,
  touched: boolean,
): void {
  control.setCustomValidity('');
  if (!(control instanceof HTMLSelectElement)) return;
  if (!control.multiple) {
    control.required = required;
    if (required && isPlaceholderSelected(control)) {
      control.setCustomValidity('Please select an option.');
    }
    return;
  }

  const count = control.selectedOptions.length;
  const included = shouldIncludeArray(property, required, touched, count);
  const minimum = integerBound(property.minItems);
  const maximum = integerBound(property.maxItems);
  // HTML's multi-select `required` means one selection, so it only matches a present array whose
  // schema minimum is at least one. Higher cardinality remains a custom JSON Schema constraint.
  control.required = included && minimum !== undefined && minimum > 0;
  if (included && minimum !== undefined && count < minimum) {
    control.setCustomValidity(`Select at least ${minimum} option${minimum === 1 ? '' : 's'}.`);
  } else if (included && maximum !== undefined && count > maximum) {
    control.setCustomValidity(`Select at most ${maximum} option${maximum === 1 ? '' : 's'}.`);
  }
}

function shouldIncludeArray(
  property: Readonly<Record<string, unknown>>,
  required: boolean,
  touched: boolean,
  selectedCount: number,
): boolean {
  return required || hasDefault(property) || touched || selectedCount > 0;
}

function hasDefault(property: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(property, 'default');
}

function integerBound(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function inputNeedsNonEmptyValue(property: Readonly<Record<string, unknown>>): boolean {
  if (property.type === 'number' || property.type === 'integer') return true;
  if (property.type !== 'string') return false;
  return (
    property.format === 'date' ||
    property.format === 'date-time' ||
    property.format === 'email' ||
    property.format === 'uri' ||
    (typeof property.minLength === 'number' && property.minLength > 0)
  );
}

function isPlaceholderSelected(select: HTMLSelectElement): boolean {
  return select.selectedOptions[0]?.dataset.placeholder === 'true';
}

function stringChoices(
  property: Readonly<Record<string, unknown>>,
): readonly { readonly value: string; readonly title: string }[] | undefined {
  if (Array.isArray(property.enum) && property.enum.every((value) => typeof value === 'string')) {
    return property.enum.map((value) => ({ value, title: value }));
  }
  return titledChoices(property.oneOf) ?? titledChoices(property.anyOf);
}

function arrayChoices(
  property: Readonly<Record<string, unknown>>,
): readonly { readonly value: string; readonly title: string }[] {
  return stringChoices(record(property.items)) ?? [];
}

function inputType(property: Readonly<Record<string, unknown>>): string {
  if (property.type === 'boolean') return 'checkbox';
  if (property.type === 'number' || property.type === 'integer') return 'number';
  if (property.format === 'date') return 'date';
  if (property.format === 'date-time') return 'datetime-local';
  if (property.format === 'email') return 'email';
  if (property.format === 'uri') return 'url';
  return 'text';
}

function titledChoices(
  value: unknown,
): readonly { readonly value: string; readonly title: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const choices = value.map((item) => record(item));
  if (!choices.every((item) => typeof item.const === 'string')) return undefined;
  return choices.map((item) => ({
    value: String(item.const),
    title: typeof item.title === 'string' ? item.title : String(item.const),
  }));
}

function applySelectDefault(select: HTMLSelectElement, value: unknown): void {
  if (select.multiple) {
    const selected = new Set(
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    );
    for (const item of select.options) item.selected = selected.has(item.value);
    return;
  }
  if (typeof value === 'string') select.value = value;
}

function applyInputDefault(
  input: HTMLInputElement,
  property: Readonly<Record<string, unknown>>,
): void {
  const value = property.default;
  if (property.type === 'boolean') {
    if (typeof value === 'boolean') input.checked = value;
    return;
  }
  if (property.type === 'number' || property.type === 'integer') {
    if (typeof value === 'number' && Number.isFinite(value)) input.value = String(value);
    return;
  }
  if (typeof value !== 'string') return;
  if (property.format === 'date-time') {
    input.value = rfc3339ToDateTimeLocal(value) ?? '';
    return;
  }
  input.value = value;
}

function rfc3339ToDateTimeLocal(value: string): string | undefined {
  const instant = new Date(value);
  if (Number.isNaN(instant.valueOf())) return undefined;
  return [
    String(instant.getFullYear()).padStart(4, '0'),
    '-',
    twoDigits(instant.getMonth() + 1),
    '-',
    twoDigits(instant.getDate()),
    'T',
    twoDigits(instant.getHours()),
    ':',
    twoDigits(instant.getMinutes()),
    ':',
    twoDigits(instant.getSeconds()),
    '.',
    String(instant.getMilliseconds()).padStart(3, '0'),
  ].join('');
}

function dateTimeLocalToRfc3339(value: string): string | undefined {
  const instant = new Date(value);
  return Number.isNaN(instant.valueOf()) ? undefined : instant.toISOString();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

function button(label: string, type: HTMLButtonElement['type']): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = type;
  element.textContent = label;
  return element;
}

function option(label: string, value: string): HTMLOptionElement {
  const element = document.createElement('option');
  element.textContent = label;
  element.value = value;
  return element;
}

function placeholderOption(
  choices: readonly { readonly value: string; readonly title: string }[],
): HTMLOptionElement {
  let value = '';
  while (choices.some((choice) => choice.value === value)) value += '\u0000';
  const element = option('', value);
  element.dataset.placeholder = 'true';
  return element;
}

function humanize(value: string): string {
  const words = value.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll(/[_-]+/g, ' ');
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : value;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

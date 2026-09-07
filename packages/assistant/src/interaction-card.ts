type InteractionAction = 'accept' | 'decline' | 'cancel';

type ReviewSchema = Readonly<Record<string, unknown>>;

interface InteractionCardOptions {
  readonly tool: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly reviewSchema?: ReviewSchema;
  readonly showDetails?: boolean;
  readonly labels: {
    readonly heading: string;
    readonly accept: string;
    readonly decline: string;
    readonly details: string;
    readonly redacted: string;
  };
  readonly respond: (action: InteractionAction) => Promise<void>;
}

export function createInteractionCard(options: InteractionCardOptions): HTMLElement {
  const card = document.createElement('section');
  card.className = 'tool-proposal';
  card.setAttribute('aria-label', options.labels.heading);

  const eyebrow = document.createElement('span');
  eyebrow.className = 'proposal-eyebrow';
  eyebrow.textContent = options.labels.heading;
  const title = document.createElement('h3');
  title.textContent = options.title ?? humanizeArgumentName(options.tool);
  card.append(eyebrow, title);

  if (options.description) {
    const description = document.createElement('p');
    description.className = 'proposal-description';
    description.textContent = options.description;
    card.append(description);
  }
  if (options.arguments && Object.keys(options.arguments).length > 0) {
    const { action, ...businessArguments } = options.arguments;
    if (Object.keys(businessArguments).length > 0) {
      card.append(createArgumentList(businessArguments, options.reviewSchema, options.labels));
    }
    if (action !== undefined && options.showDetails === true) {
      const technical = document.createElement('details');
      technical.className = 'proposal-details';
      const summary = document.createElement('summary');
      summary.textContent = options.labels.details;
      const properties = record(options.reviewSchema?.properties);
      technical.append(summary);
      const actionObject = record(action);
      if (actionObject) {
        technical.append(
          createArgumentList(actionObject, record(properties?.action), options.labels),
        );
      } else {
        const value = document.createElement('div');
        appendValue(value, action, record(properties?.action), options.labels);
        technical.append(value);
      }
      card.append(technical);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'proposal-actions';
  const buttons: HTMLButtonElement[] = [];
  for (const [labelText, action] of [
    [options.labels.accept, 'accept'],
    [options.labels.decline, 'decline'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `proposal-${action}`;
    button.textContent = labelText;
    buttons.push(button);
    button.addEventListener('click', () => {
      for (const candidate of buttons) candidate.disabled = true;
      void options.respond(action).catch(() => {
        for (const candidate of buttons) candidate.disabled = false;
      });
    });
    actions.append(button);
  }
  card.append(actions);
  return card;
}

export function createResultCard(
  result: unknown,
  label: string,
  redactedLabel: string,
): HTMLElement {
  const card = document.createElement('section');
  card.className = 'tool-result';
  const heading = document.createElement('strong');
  heading.textContent = label;
  card.append(heading);
  const body = document.createElement('div');
  const labels = {
    heading: label,
    accept: '',
    decline: '',
    details: '',
    redacted: redactedLabel,
  };
  appendValue(body, result, undefined, labels);
  card.append(body);
  return card;
}

function createArgumentList(
  arguments_: Readonly<Record<string, unknown>>,
  schema: ReviewSchema | undefined,
  labels: InteractionCardOptions['labels'],
): HTMLDListElement {
  const list = document.createElement('dl');
  list.className = 'proposal-arguments';
  const properties = record(schema?.properties);
  for (const [name, value] of Object.entries(arguments_)) {
    const propertySchema = record(properties?.[name]);
    const term = document.createElement('dt');
    term.textContent = string(propertySchema?.title) ?? humanizeArgumentName(name);
    const help = string(propertySchema?.description);
    if (help) {
      const description = document.createElement('small');
      description.textContent = help;
      term.append(description);
    }
    const description = document.createElement('dd');
    appendValue(description, value, propertySchema, labels);
    list.append(term, description);
  }
  return list;
}

function appendValue(
  parent: HTMLElement,
  value: unknown,
  schema: ReviewSchema | undefined,
  labels: InteractionCardOptions['labels'],
): void {
  if (schema?.writeOnly === true || schema?.['x-sensitive'] === true || value === '[REDACTED]') {
    const hidden = document.createElement('span');
    hidden.className = 'proposal-redacted';
    hidden.textContent = labels.redacted;
    parent.append(hidden);
    return;
  }
  if (Array.isArray(value)) {
    const list = document.createElement('ul');
    const itemSchema = record(schema?.items);
    for (const item of value) {
      const entry = document.createElement('li');
      appendValue(entry, item, itemSchema, labels);
      list.append(entry);
    }
    parent.append(list);
    return;
  }
  const objectValue = record(value);
  if (objectValue) {
    parent.append(createArgumentList(objectValue, schema, labels));
    return;
  }
  parent.textContent = formatScalar(value, schema);
}

function formatScalar(value: unknown, schema: ReviewSchema | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return new Intl.NumberFormat().format(value);
  if (typeof value !== 'string') return String(value);
  if (schema?.format === 'date') {
    const date = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(date.valueOf()))
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
  }
  if (schema?.format === 'date-time') {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf()))
      return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
        date,
      );
  }
  return value;
}

function humanizeArgumentName(value: string): string {
  const words = value.replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll(/[_-]+/g, ' ');
  return words ? `${words[0]?.toUpperCase() ?? ''}${words.slice(1)}` : value;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

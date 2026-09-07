import { isValidName } from '@noodle-borg/compiler';
import { isConfigRef, serializeVariableRef } from './config.js';
import type { ConnectorRef } from './connectors.js';
import type { AmbientContextOptions } from './context.js';
import { toJsonSchema } from './json-schema.js';
import type { ResourceContext, ToolContext, ToolOptions } from './server.js';

export type SymbolicScope = Ref & Record<string, Ref>;
export type ConnectorClient = Record<
  string,
  (args?: Readonly<Record<string, unknown>>) => SymbolicScope
>;

type RecordedStep =
  | {
      readonly id: string;
      readonly use: string;
      readonly args: Record<string, unknown>;
      readonly if?: string;
    }
  | {
      readonly id: string;
      readonly elicit: {
        readonly message: string;
        readonly requestedSchema: Record<string, unknown>;
      };
      readonly if?: string;
    };

interface RecordingContext {
  readonly steps: RecordedStep[];
  readonly counts: Map<string, number>;
  readonly stepIds: Set<string>;
  pendingCondition?: string;
}

let activeRecording: RecordingContext | undefined;

export function when<T>(condition: Cond, record: () => T): T {
  if (!activeRecording)
    throw new Error('when() can only be used while recording a tool fulfilment');
  const previous = activeRecording.pendingCondition;
  activeRecording.pendingCondition = condition.toExpression();
  try {
    return record();
  } finally {
    if (previous === undefined) delete activeRecording.pendingCondition;
    else activeRecording.pendingCondition = previous;
  }
}

export async function recordTool(
  fulfil: ToolOptions['fulfil'],
  connectors: Readonly<Record<string, ConnectorRef>>,
): Promise<{ steps: RecordedStep[]; output: Record<string, unknown> }> {
  const ctx = newRecordingContext();
  activeRecording = ctx;
  try {
    const result = await fulfil({
      input: makeScope('input') as SymbolicScope,
      user: makeScope('user') as SymbolicScope,
      context: makeScope('context') as SymbolicScope,
      connectors: makeConnectors(connectors, ctx),
      elicit: makeElicitor(ctx),
    });
    return { steps: ctx.steps, output: serializeMap(result) };
  } finally {
    activeRecording = undefined;
  }
}

/**
 * Record a resource/prompt `fulfil`. Identical recording machinery to {@link recordTool}, but the context
 * exposes the input scope as `input` (a templated resource's URI variables, or a prompt's arguments — both
 * the `input` expression root), and the single return value is wrapped as `{ value }` for the runtime.
 */
export async function recordFulfilment(
  fulfil: (ctx: ResourceContext) => unknown | Promise<unknown>,
  connectors: Readonly<Record<string, ConnectorRef>>,
  kind: 'resource' | 'prompt' = 'resource',
): Promise<{ steps: RecordedStep[]; output: Record<string, unknown> }> {
  const ctx = newRecordingContext();
  activeRecording = ctx;
  try {
    const result = await fulfil({
      input: makeScope('input') as SymbolicScope,
      user: makeScope('user') as SymbolicScope,
      context: makeScope('context') as SymbolicScope,
      connectors: makeConnectors(connectors, ctx),
    });
    // A resource `fulfil` that returns the MCP read-result wrapper `{ contents: [...] }` double-wraps:
    // the runtime maps the return INTO `contents`, so the whole `{"contents":[...]}` blob would land in
    // contents[0].text. Reject it here so `noodle validate` fails loudly — the layer agents actually run,
    // not only at read time. Resource-scoped (a prompt returning arbitrary `contents` data is fine); the
    // runtime guard in protocol/mapping.ts is the defense-in-depth counterpart for dynamic returns.
    if (
      kind === 'resource' &&
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      Array.isArray((result as { contents?: unknown }).contents)
    ) {
      throw new Error(
        'resource fulfil returned a { contents: [...] } wrapper; return the bare content entry ' +
          '`{ uri, mimeType, text }` or a plain string — the runtime maps your return into `contents`.',
      );
    }
    return { steps: ctx.steps, output: { value: serializeReturn(result) } };
  } finally {
    activeRecording = undefined;
  }
}

/**
 * Record the server's per-invocation ambient-context provider. The callback runs only while authoring;
 * its connector calls and result mapping become manifest data. Ambient context is observational, so an
 * action operation is rejected before a manifest can be emitted.
 */
export async function recordAmbientContext(
  fulfil: AmbientContextOptions['fulfil'],
  connectors: Readonly<Record<string, ConnectorRef>>,
): Promise<{ steps: RecordedStep[]; output: Record<string, unknown> }> {
  const ctx = newRecordingContext();
  activeRecording = ctx;
  try {
    const result = await fulfil({
      user: makeScope('user') as SymbolicScope,
      context: makeScope('context') as SymbolicScope,
      connectors: makeConnectors(connectors, ctx, { readOnly: true }),
    });
    return { steps: ctx.steps, output: serializeMap(result) };
  } finally {
    activeRecording = undefined;
  }
}

function newRecordingContext(): RecordingContext {
  return { steps: [], counts: new Map(), stepIds: new Set() };
}

function makeElicitor(ctx: RecordingContext): ToolContext['elicit'] {
  return ((options: {
    readonly id: string;
    readonly message: string;
    readonly input: Parameters<typeof toJsonSchema>[0];
  }) => {
    if (!isValidName(options.id)) {
      throw new Error(
        `elicitation id "${options.id}" must use lowercase letters, numbers, and underscores`,
      );
    }
    if (!options.message.trim()) throw new Error('elicitation message must not be empty');
    if (ctx.stepIds.has(options.id)) {
      throw new Error(`duplicate fulfilment step id "${options.id}"`);
    }
    ctx.stepIds.add(options.id);
    ctx.steps.push({
      id: options.id,
      elicit: {
        message: options.message.trim(),
        requestedSchema: toJsonSchema(options.input, 'input'),
      },
      ...(ctx.pendingCondition ? { if: ctx.pendingCondition } : {}),
    });
    return makeScope(`steps.${options.id}`) as SymbolicScope;
  }) as ToolContext['elicit'];
}

function makeConnectors(
  connectors: Readonly<Record<string, ConnectorRef>>,
  ctx: RecordingContext,
  restrictions: { readonly readOnly?: boolean } = {},
): Record<string, ConnectorClient> {
  return Object.fromEntries(
    Object.entries(connectors).map(([alias, c]) => [
      alias,
      makeConnectorClient(alias, c, ctx, restrictions),
    ]),
  );
}

function makeConnectorClient(
  alias: string,
  c: ConnectorRef,
  ctx: RecordingContext,
  restrictions: { readonly readOnly?: boolean },
): ConnectorClient {
  const operations = new Map<string, string>();
  for (const op of Object.keys(c.operations)) {
    operations.set(op, op);
    operations.set(toCamelCase(op), op);
  }

  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== 'string') return undefined;
        const op = operations.get(prop);
        if (!op) {
          return () => {
            throw new Error(`unknown operation "${prop}" on connector alias "${alias}"`);
          };
        }
        return (args: Readonly<Record<string, unknown>> = {}) => {
          if (restrictions.readOnly === true && c.operations[op]?.type !== 'read') {
            throw new Error(
              `ambient context providers may call read-only operations only; ` +
                `"${alias}.${op}" is an action`,
            );
          }
          const stepId = nextStepId(ctx, op);
          ctx.steps.push({
            id: stepId,
            use: `${alias}.${op}`,
            args: serializeConnectorArgs(args),
            ...(ctx.pendingCondition ? { if: ctx.pendingCondition } : {}),
          });
          return makeScope(`steps.${stepId}`);
        };
      },
    },
  ) as ConnectorClient;
}

function nextStepId(ctx: RecordingContext, op: string): string {
  let count = ctx.counts.get(op) ?? 0;
  let candidate: string;
  do {
    candidate = count === 0 ? op : `${op}_${count + 1}`;
    count += 1;
  } while (ctx.stepIds.has(candidate));
  ctx.counts.set(op, count);
  ctx.stepIds.add(candidate);
  return candidate;
}

function makeScope(path: string): Ref {
  return makeRef(path);
}

export interface Ref {
  equals(value: unknown): Cond;
  /** Select one array element with bounded, explicit bracket-index syntax. */
  at(index: number): Ref;
  optional(): Ref;
  toExpression(): string;
}

export interface Cond {
  toExpression(): string;
}

function makeRef(path: string): Ref {
  const methods = {
    equals(value: unknown): Cond {
      return { toExpression: () => expr(`${path} === ${literal(value)}`) };
    },
    at(index: number): Ref {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new Error('symbolic array indexes must be non-negative safe integers');
      }
      return makeRef(`${path}[${index}]`);
    },
    optional(): Ref {
      return proxy;
    },
    toExpression(): string {
      return expr(path);
    },
    // Coercing a ref to a string yields its `${path}` expression, so template literals compose naturally
    // (e.g. `Triage ${args.id}` records the string `"Triage ${input.id}"`, parsed as a template later).
    toString(): string {
      return expr(path);
    },
  };

  // The proxy target is a callable (arrow) function purely so the `apply` trap fires when authoring code
  // mistakenly *calls* a symbolic ref (e.g. `input.name.trim()`) — turning an opaque `TypeError: ... is
  // not a function` into a teaching error. An arrow function has no own `prototype`, so the get trap
  // never trips a Proxy non-configurable-property invariant. The target itself is never invoked.
  const target: object = () => undefined;

  const proxy = new Proxy(target, {
    get(_obj, prop) {
      if (prop === Symbol.toPrimitive) return () => expr(path);
      if (typeof prop !== 'string') return undefined;
      // A ref must not look like a Promise. Now that the target is callable, a truthy callable `then`
      // would make `await ref` (or returning a ref from an async `fulfil`) invoke `ref.then(...)` and
      // trip the apply trap. Reporting `then` as absent keeps a ref a plain, serializable value.
      if (prop === 'then') return undefined;
      // Only the explicit ref methods resolve; every other string key (including function built-ins
      // like `name`/`length`) is a deeper path into the symbolic ref (e.g. `input.order.id`).
      if (Object.hasOwn(methods, prop)) return methods[prop as keyof typeof methods];
      return makeRef(`${path}.${prop}`);
    },
    apply() {
      throw new Error(
        `cannot call methods (e.g. .trim()) on a symbolic input ref '${path}' — its value isn't known ` +
          'until runtime; use a template literal `${...}` for string composition or when(...) for ' +
          'conditional flow.',
      );
    },
  }) as unknown as Ref;
  return proxy;
}

function serializeMap(value: unknown): Record<string, unknown> {
  if (isRef(value) || isCond(value)) {
    throw new Error('tool fulfilment must return a plain object mapping');
  }
  if (!isPlainObject(value)) {
    throw new Error('tool fulfilment must return a plain object mapping');
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeValue(v)]));
}

function serializeValue(value: unknown): unknown {
  return serializeTree(value, 'tool fulfilment');
}

/**
 * Recursively serialize a fulfilment value into mapping data: refs/conds become `${...}`
 * expressions, arrays and plain objects recurse (the compiler's nested-mapping support carries
 * them), scalars pass verbatim. Arrays and nested objects are the natural shape for list-style
 * tool output and widget props (carousels, search results), not just resource/prompt blobs.
 */
function serializeTree(value: unknown, context: string): unknown {
  if (isConfigRef(value)) return serializeVariableRef(value, context);
  if (isRef(value) || isCond(value)) return value.toExpression();
  if (Array.isArray(value)) return value.map((item) => serializeTree(item, context));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, serializeTree(v, context)]),
    );
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  throw new Error(`cannot serialize ${typeof value} from ${context}`);
}

function serializeConnectorArgs(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serializeReturn(v)]));
}

/**
 * Serialize a resource/prompt `fulfil` return value into the single-key `{ value }` wrapper the runtime
 * unwraps. Unlike tool output (an object of named fields), a resource/prompt returns one value — a
 * string, a symbolic ref, or a structure.
 */
function serializeReturn(value: unknown): unknown {
  return serializeTree(value, 'a resource/prompt fulfilment');
}

function isRef(value: unknown): value is Ref {
  // A symbolic ref is now a callable-function-backed proxy (so an accidental call is a teaching error),
  // so accept `'function'` as well as `'object'` — otherwise refs would no longer serialize.
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { toExpression?: unknown }).toExpression === 'function'
  );
}

function isCond(value: unknown): value is Cond {
  return isRef(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function expr(path: string): string {
  return `\${${path}}`;
}

function literal(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return String(value);
  throw new Error('conditions can compare symbolic references to scalar literals only');
}

function toCamelCase(value: string): string {
  return value.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

import type { CondNode, ExprNode, PathNode, PathSegment } from '@noodle-borg/compiler';

/**
 * The data an expression may read, keyed by root name. Manifest expressions are evaluated with
 * `{ input, steps }` (`steps` is `{}` for single-operation fulfilment); other contexts pass their own
 * roots (e.g. connector request/response mapping uses `{ args }` / `{ args, response }`). Only the roots
 * present here are reachable — an expression can never reach process environment, filesystem, network,
 * globals, secrets, or inbound tokens (docs/SPEC.md "Expression language").
 */
export type EvalScope = Readonly<Record<string, unknown>>;

/** Reasons evaluation fails. The path locates the offending expression without leaking values. */
export type ExpressionEvalErrorCode = 'output_too_large' | 'invalid_node';

/**
 * Raised when AST evaluation cannot complete. Carries a stable code and the expression's field
 * path; never the resolved value (docs/SPEC.md: "identify the expression path without leaking
 * sensitive values").
 */
export class ExpressionEvalError extends Error {
  readonly code: ExpressionEvalErrorCode;
  readonly path: string | undefined;

  constructor(code: ExpressionEvalErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ExpressionEvalError';
    this.code = code;
    this.path = path;
  }
}

/** Upper bound on a single interpolated string, guarding against runaway template output. */
const MAX_STRING_LENGTH = 1 << 20; // 1 MiB

/**
 * Evaluate a value expression against the scope. Walks the AST the compiler already produced — it
 * never parses strings and never uses `eval`/`Function` (docs/SPEC.md "Expression language").
 *
 * - `literal` returns its value verbatim (type preserved).
 * - `path` resolves `root` + segments; a missing or non-indexable segment yields `undefined`.
 * - `template` concatenates its parts into a string (interpolation always produces a string).
 * - `array` / `object` build the structured value, evaluating each item/field expression; object
 *   entries whose value resolves to `undefined` are omitted (mirroring top-level mapping behavior).
 */
export function evaluateValue(node: ExprNode, scope: EvalScope, path?: string): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return resolvePath(node, scope);
    case 'template': {
      let out = '';
      for (const part of node.parts) {
        out += part.kind === 'text' ? part.value : stringify(evaluateValue(part, scope, path));
        if (out.length > MAX_STRING_LENGTH) {
          throw new ExpressionEvalError(
            'output_too_large',
            'template output exceeds the size limit',
            path,
          );
        }
      }
      return out;
    }
    case 'array':
      return node.items.map((item) => evaluateValue(item, scope, path));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const entry of node.entries) {
        const value = evaluateValue(entry.value, scope, path);
        if (value !== undefined) out[entry.key] = value;
      }
      return out;
    }
    case 'coalesce': {
      const left = evaluateValue(node.left, scope, path);
      return left === null || left === undefined ? evaluateValue(node.right, scope, path) : left;
    }
    case 'function':
      return evaluateFunction(
        node.name,
        node.args.map((arg) => evaluateValue(arg, scope, path)),
        path,
      );
    default:
      throw new ExpressionEvalError('invalid_node', `unsupported expression node`, path);
  }
}

/**
 * Evaluate a boolean condition (a step `if`) against the scope. Equality is strict; logical `and`
 * and `or` short-circuit; `truthy` applies JS truthiness to a resolved path. Built for the flow
 * slice; single-operation fulfilment carries no conditions.
 */
export function evaluateCondition(node: CondNode, scope: EvalScope, path?: string): boolean {
  if (node.kind === 'truthy') {
    return Boolean(resolvePath(node.operand, scope));
  }
  switch (node.op) {
    case 'eq':
      return evaluateValue(node.left, scope, path) === evaluateValue(node.right, scope, path);
    case 'neq':
      return evaluateValue(node.left, scope, path) !== evaluateValue(node.right, scope, path);
    case 'and':
      return (
        evaluateCondition(node.left, scope, path) && evaluateCondition(node.right, scope, path)
      );
    case 'or':
      return (
        evaluateCondition(node.left, scope, path) || evaluateCondition(node.right, scope, path)
      );
    case 'not':
      return !evaluateCondition(node.operand, scope, path);
    default:
      throw new ExpressionEvalError('invalid_node', 'unsupported condition node', path);
  }
}

/** Resolve a path expression to its value, or `undefined` if any segment is missing. */
function resolvePath(node: PathNode, scope: EvalScope): unknown {
  let current: unknown = scope[node.root];
  for (const segment of node.segments) {
    if (current === null || current === undefined) return undefined;
    current = step(current, segment);
  }
  return current;
}

/** Read one path segment. Uses own-property access only, so no prototype chain is reachable. */
function step(current: unknown, segment: PathSegment): unknown {
  if (segment.kind === 'index') {
    return Array.isArray(current) ? current[segment.value] : undefined;
  }
  if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment.name)) {
    return undefined;
  }
  return (current as Record<string, unknown>)[segment.name];
}

/** Coerce an interpolated value to a string deterministically. */
function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function evaluateFunction(name: string, args: readonly unknown[], path?: string): unknown {
  switch (name) {
    case 'coalesce':
      return args.find((arg) => arg !== null && arg !== undefined);
    case 'equals':
      return args[0] === args[1];
    case 'lower':
      return stringify(args[0]).toLowerCase();
    case 'upper':
      return stringify(args[0]).toUpperCase();
    case 'formatCurrency':
      return formatCurrency(args, path);
    case 'formatNumber':
      return formatNumber(args, path);
    case 'formatDateTime':
      return formatDateTime(args, path);
    case 'formatRelativeTime':
      return formatRelativeTime(args, path);
    case 'formatUnit':
      return formatUnit(args, path);
    case 'formatPlural':
      return formatPlural(args, path);
    case 'urlEncode':
      return encodeURIComponent(stringify(args[0]));
    default:
      throw new ExpressionEvalError('invalid_node', `unsupported expression function`, path);
  }
}

function formatCurrency(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () =>
    new Intl.NumberFormat(localeArg(args[2]), {
      style: 'currency',
      currency: requiredString(args[1], 'currency', path),
    }).format(numberArg(args[0], 'value', path)),
  );
}

function formatNumber(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () =>
    new Intl.NumberFormat(localeArg(args[1])).format(numberArg(args[0], 'value', path)),
  );
}

function formatDateTime(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () => {
    const value = new Date(requiredString(args[0], 'value', path));
    if (Number.isNaN(value.getTime())) throw new Error('invalid date');
    const dateStyle = optionalString(args[2]);
    const timeStyle = optionalString(args[3]);
    return new Intl.DateTimeFormat(localeArg(args[1]), {
      dateStyle: isDateTimeStyle(dateStyle) ? dateStyle : 'medium',
      ...(timeStyle === undefined ? {} : { timeStyle: requireDateTimeStyle(timeStyle, path) }),
      timeZone: optionalString(args[4]) ?? 'UTC',
    }).format(value);
  });
}

function formatRelativeTime(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () =>
    new Intl.RelativeTimeFormat(localeArg(args[2]), { numeric: 'auto' }).format(
      numberArg(args[0], 'value', path),
      requireRelativeTimeUnit(requiredString(args[1], 'unit', path), path),
    ),
  );
}

function formatUnit(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () =>
    new Intl.NumberFormat(localeArg(args[2]), {
      style: 'unit',
      unit: requiredString(args[1], 'unit', path),
    }).format(numberArg(args[0], 'value', path)),
  );
}

function formatPlural(args: readonly unknown[], path?: string): string {
  return withFormatterError(path, () => {
    const count = numberArg(args[0], 'value', path);
    const one = requiredString(args[2], 'oneText', path);
    const other = requiredString(args[3], 'otherText', path);
    const selected = new Intl.PluralRules(localeArg(args[1])).select(count);
    return selected === 'one'
      ? pluralTemplate(one, count, false)
      : pluralTemplate(other, count, true);
  });
}

function withFormatterError(path: string | undefined, fn: () => string): string {
  try {
    return fn();
  } catch {
    throw new ExpressionEvalError('invalid_node', 'invalid formatter options', path);
  }
}

function localeArg(value: unknown): string {
  const locale = optionalString(value);
  return locale === undefined || locale === '' ? 'en-US' : locale;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return stringify(value);
}

function requiredString(value: unknown, label: string, path?: string): string {
  const out = optionalString(value);
  if (out === undefined || out === '') {
    throw new ExpressionEvalError('invalid_node', `missing formatter ${label}`, path);
  }
  return out;
}

function numberArg(value: unknown, label: string, path?: string): number {
  const out = Number(value);
  if (!Number.isFinite(out)) {
    throw new ExpressionEvalError('invalid_node', `invalid formatter ${label}`, path);
  }
  return out;
}

function isDateTimeStyle(value: string | undefined): value is 'full' | 'long' | 'medium' | 'short' {
  return value === 'full' || value === 'long' || value === 'medium' || value === 'short';
}

function requireDateTimeStyle(value: string, path?: string): 'full' | 'long' | 'medium' | 'short' {
  if (isDateTimeStyle(value)) return value;
  throw new ExpressionEvalError('invalid_node', 'invalid formatter date/time style', path);
}

function requireRelativeTimeUnit(value: string, path?: string): Intl.RelativeTimeFormatUnit {
  if (
    value === 'second' ||
    value === 'minute' ||
    value === 'hour' ||
    value === 'day' ||
    value === 'week' ||
    value === 'month' ||
    value === 'quarter' ||
    value === 'year'
  ) {
    return value;
  }
  throw new ExpressionEvalError('invalid_node', 'invalid formatter relative time unit', path);
}

function pluralTemplate(text: string, count: number, prefixCount: boolean): string {
  if (text.includes('{{count}}')) return text.replaceAll('{{count}}', String(count));
  if (text.includes('{count}')) return text.replaceAll('{count}', String(count));
  return prefixCount ? `${count} ${text}` : text;
}

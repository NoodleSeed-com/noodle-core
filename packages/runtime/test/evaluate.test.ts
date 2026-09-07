import { parseCondition, parseValue } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import {
  type EvalScope,
  ExpressionEvalError,
  evaluateCondition,
  evaluateValue,
} from '../src/eval/evaluate.js';

function value(raw: unknown, scope: EvalScope): unknown {
  const { node, errors } = parseValue(raw, 'p');
  expect(errors).toEqual([]);
  return evaluateValue(node, scope, 'p');
}

function condition(raw: string, scope: EvalScope): boolean {
  const { node, errors } = parseCondition(raw, 'p');
  expect(errors).toEqual([]);
  return evaluateCondition(node, scope, 'p');
}

const scope = (input: unknown): EvalScope => ({ input, steps: {} });

describe('evaluateValue', () => {
  it('returns a literal verbatim, preserving type', () => {
    expect(value(42, scope({}))).toBe(42);
    expect(value(true, scope({}))).toBe(true);
    expect(value('plain', scope({}))).toBe('plain');
  });

  it('resolves a property path', () => {
    expect(value('${input.user.name}', scope({ user: { name: 'Ada' } }))).toBe('Ada');
  });

  it('resolves an array index path', () => {
    expect(value('${input.items[1]}', scope({ items: ['a', 'b'] }))).toBe('b');
  });

  it('yields undefined for a missing segment (no throw)', () => {
    expect(value('${input.a.b}', scope({}))).toBeUndefined();
    expect(value('${input.items[5]}', scope({ items: [] }))).toBeUndefined();
  });

  it('does not reach the prototype chain', () => {
    expect(value('${input.constructor}', scope({}))).toBeUndefined();
  });

  it('builds a string template', () => {
    expect(value('Hi ${input.name}!', scope({ name: 'Ada' }))).toBe('Hi Ada!');
  });

  it('coerces interpolated values to strings (null/undefined -> empty)', () => {
    const s = scope({ n: 3, b: true, x: null });
    expect(value('n=${input.n} b=${input.b} x=${input.x} m=${input.missing}', s)).toBe(
      'n=3 b=true x= m=',
    );
  });

  it('guards against oversized template output', () => {
    const big = 'x'.repeat((1 << 20) + 10);
    const { node } = parseValue('p${input.big}', 'p');
    expect(() => evaluateValue(node, scope({ big }), 'p')).toThrow(ExpressionEvalError);
    try {
      evaluateValue(node, scope({ big }), 'p');
    } catch (err) {
      expect((err as ExpressionEvalError).code).toBe('output_too_large');
    }
  });
});

describe('evaluateCondition', () => {
  it('compares with strict equality', () => {
    expect(condition('${input.a === input.b}', scope({ a: 1, b: 1 }))).toBe(true);
    expect(condition('${input.a === input.b}', scope({ a: 1, b: 2 }))).toBe(false);
    expect(condition('${input.status === "open"}', scope({ status: 'open' }))).toBe(true);
  });

  it('supports inequality', () => {
    expect(condition('${input.a !== input.b}', scope({ a: 1, b: 2 }))).toBe(true);
  });

  it('applies JS truthiness to a bare path', () => {
    expect(condition('${input.flag}', scope({ flag: true }))).toBe(true);
    expect(condition('${input.flag}', scope({ flag: '' }))).toBe(false);
    expect(condition('${input.flag}', scope({ flag: 0 }))).toBe(false);
    expect(condition('${input.flag}', scope({}))).toBe(false);
  });

  it('negates with not', () => {
    expect(condition('${!input.flag}', scope({ flag: false }))).toBe(true);
  });

  it('combines with and / or', () => {
    expect(condition('${input.a && input.b}', scope({ a: true, b: true }))).toBe(true);
    expect(condition('${input.a && input.b}', scope({ a: true, b: false }))).toBe(false);
    expect(condition('${input.a || input.b}', scope({ a: false, b: true }))).toBe(true);
    expect(condition('${input.a || input.b}', scope({ a: false, b: false }))).toBe(false);
  });
});

describe('evaluateValue — nested structures', () => {
  it('evaluates an array of mixed literals and paths', () => {
    expect(value(['a', '${input.x}', 3], scope({ x: 'b' }))).toEqual(['a', 'b', 3]);
  });

  it('builds a nested object/array body with substituted paths', () => {
    const body = value(
      { model: '${input.model}', messages: [{ role: 'user', content: '${input.query}' }] },
      scope({ model: 'sonar', query: 'why is the sky blue?' }),
    );
    expect(body).toEqual({
      model: 'sonar',
      messages: [{ role: 'user', content: 'why is the sky blue?' }],
    });
  });

  it('omits object entries whose value resolves to undefined', () => {
    // input.missing is absent -> the `model` entry is dropped, not set to undefined.
    expect(value({ q: '${input.q}', model: '${input.missing}' }, scope({ q: 'hi' }))).toEqual({
      q: 'hi',
    });
  });

  it('preserves type for a whole-expression numeric/boolean leaf inside a structure', () => {
    expect(value({ n: '${input.n}', ok: '${input.ok}' }, scope({ n: 7, ok: true }))).toEqual({
      n: 7,
      ok: true,
    });
  });
});

describe('evaluateValue — ?? fallback', () => {
  it('returns the left value when present (type preserved)', () => {
    expect(value('${input.model ?? "sonar"}', scope({ model: 'sonar-pro' }))).toBe('sonar-pro');
    expect(value('${input.n ?? 0}', scope({ n: 7 }))).toBe(7);
  });

  it('falls back to the right when the left is missing (undefined)', () => {
    expect(value('${input.model ?? "sonar"}', scope({}))).toBe('sonar');
  });

  it('falls back when the left is null', () => {
    expect(value('${input.model ?? "sonar"}', scope({ model: null }))).toBe('sonar');
  });

  it('does NOT fall back on falsy-but-present values (0, "", false)', () => {
    expect(value('${input.n ?? 99}', scope({ n: 0 }))).toBe(0);
    expect(value('${input.s ?? "d"}', scope({ s: '' }))).toBe('');
    expect(value('${input.b ?? true}', scope({ b: false }))).toBe(false);
  });

  it('chains left-to-right, using the first present value', () => {
    expect(value('${input.a ?? input.b ?? "d"}', scope({ b: 'B' }))).toBe('B');
    expect(value('${input.a ?? input.b ?? "d"}', scope({}))).toBe('d');
  });

  it('uses ?? inside a nested request body', () => {
    const body = value(
      { model: '${input.model ?? "sonar"}', messages: [{ content: '${input.q}' }] },
      scope({ q: 'hi' }),
    );
    expect(body).toEqual({ model: 'sonar', messages: [{ content: 'hi' }] });
  });
});

describe('evaluateValue — pure functions', () => {
  it('evaluates the allowlist and locale-aware formatters', () => {
    const s = scope({
      name: 'Ada',
      total: 1234.5,
      date: '2026-06-11T12:00:00.000Z',
      days: -2,
      count: 3,
      url: 'a b&c',
      missing: null,
    });
    expect(value('${lower(input.name)}', s)).toBe('ada');
    expect(value('${upper(input.name)}', s)).toBe('ADA');
    expect(value('${equals(input.name, "Ada")}', s)).toBe(true);
    expect(value('${coalesce(input.missing, input.name, "fallback")}', s)).toBe('Ada');
    expect(value('${formatCurrency(input.total, "EUR", "de-DE")}', s)).toBe('1.234,50 €');
    expect(value('${formatNumber(input.total, "ja-JP")}', s)).toBe('1,234.5');
    expect(
      value('${formatDateTime(input.date, "en-GB", "medium", "short", "Europe/London")}', s),
    ).toBe('11 Jun 2026, 13:00');
    expect(value('${formatRelativeTime(input.days, "day", "en-US")}', s)).toBe('2 days ago');
    expect(value('${formatUnit(input.total, "kilometer", "de-DE")}', s)).toBe('1.234,5 km');
    expect(value('${formatPlural(input.count, "en-US", "1 item", "items")}', s)).toBe('3 items');
    expect(value('${urlEncode(input.url)}', s)).toBe('a%20b%26c');
  });

  it('fails closed for invalid formatter options', () => {
    expect(() =>
      value('${formatCurrency(input.total, "not-a-currency", "en-US")}', scope({ total: 1 })),
    ).toThrow('invalid formatter options');
  });
});

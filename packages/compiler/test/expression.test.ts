import { describe, expect, it } from 'vitest';
import { collectPaths, parseCondition, parseValue } from '../src/manifest/expression.js';

describe('parseValue', () => {
  it('non-string scalars become literals (type preserved)', () => {
    expect(parseValue(5, 'p')).toEqual({ node: { kind: 'literal', value: 5 }, errors: [] });
    expect(parseValue(true, 'p')).toEqual({ node: { kind: 'literal', value: true }, errors: [] });
    expect(parseValue(null, 'p')).toEqual({ node: { kind: 'literal', value: null }, errors: [] });
  });

  it('a plain string with no ${} is a literal', () => {
    expect(parseValue('hello', 'p').node).toEqual({ kind: 'literal', value: 'hello' });
  });

  it('unescapes $${ to a literal ${', () => {
    expect(parseValue('cost is $${x}', 'p').node).toEqual({
      kind: 'literal',
      value: 'cost is ${x}',
    });
  });

  it('a whole-field path preserves type', () => {
    const { node, errors } = parseValue('${input.order_id}', 'p');
    expect(errors).toEqual([]);
    expect(node).toEqual({
      kind: 'path',
      root: 'input',
      segments: [{ kind: 'prop', name: 'order_id' }],
    });
  });

  it('parses array index access', () => {
    const { node } = parseValue('${steps.search.items[0].id}', 'p');
    expect(node).toEqual({
      kind: 'path',
      root: 'steps',
      segments: [
        { kind: 'prop', name: 'search' },
        { kind: 'prop', name: 'items' },
        { kind: 'index', value: 0 },
        { kind: 'prop', name: 'id' },
      ],
    });
  });

  it('a whole-field literal preserves type', () => {
    expect(parseValue('${42}', 'p').node).toEqual({ kind: 'literal', value: 42 });
    expect(parseValue('${true}', 'p').node).toEqual({ kind: 'literal', value: true });
  });

  it('mixed text + expression is a template', () => {
    const { node } = parseValue('Order ${input.id}!', 'p');
    expect(node).toEqual({
      kind: 'template',
      parts: [
        { kind: 'text', value: 'Order ' },
        { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'id' }] },
        { kind: 'text', value: '!' },
      ],
    });
  });

  it('rejects operators outside an if condition', () => {
    expect(parseValue('${input.x === input.y}', 'p').errors[0]).toMatchObject({
      code: 'expr_operator_not_allowed',
      path: 'p',
    });
  });

  it('enriches expr_operator_not_allowed with got + docAnchor', () => {
    expect(parseValue('${input.x === input.y}', 'p').errors[0]).toMatchObject({
      code: 'expr_operator_not_allowed',
      got: '===',
      docAnchor: 'compile-errors#expr-operator-not-allowed',
    });
  });

  it('rejects an unknown root', () => {
    expect(parseValue('${foo.x}', 'p').errors[0]?.code).toBe('expr_unknown_root');
  });

  it('enriches expr_unknown_root with got (bad root) + expected (available roots) + docAnchor', () => {
    expect(parseValue('${foo.x}', 'p').errors[0]).toMatchObject({
      code: 'expr_unknown_root',
      got: 'foo',
      expected: 'input, steps, env, user, context',
      docAnchor: 'compile-errors#expr-unknown-root',
    });
  });

  it('allows the user root and rejects a deferred root distinctly', () => {
    expect(parseValue('${user.email}', 'p').errors).toEqual([]);
    expect(parseValue('${item.name}', 'p').errors[0]?.code).toBe('expr_root_unavailable');
  });

  it('enriches expr_root_unavailable with got (deferred root) + expected + docAnchor', () => {
    expect(parseValue('${item.name}', 'p').errors[0]).toMatchObject({
      code: 'expr_root_unavailable',
      got: 'item',
      expected: 'input, steps, env, user, context',
      docAnchor: 'compile-errors#expr-root-unavailable',
    });
  });

  it('rejects an empty expression', () => {
    expect(parseValue('${}', 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('rejects an unterminated expression', () => {
    expect(parseValue('${input.x', 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('rejects an overly deep path', () => {
    const deep = `\${input.${Array.from({ length: 33 }, (_, i) => `p${i}`).join('.')}}`;
    expect(parseValue(deep, 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('rejects overly large strings and templates', () => {
    expect(parseValue('x'.repeat(16_385), 'p').errors[0]?.code).toBe('invalid_expression');
    const template = Array.from({ length: 65 }, (_, i) => `\${input.p${i}}`).join('-');
    expect(parseValue(template, 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('parses an array of value expressions into an array node', () => {
    const { node, errors } = parseValue(['a', '${input.x}', 2], 'p');
    expect(errors).toEqual([]);
    expect(node).toEqual({
      kind: 'array',
      items: [
        { kind: 'literal', value: 'a' },
        { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'x' }] },
        { kind: 'literal', value: 2 },
      ],
    });
  });

  it('parses a nested object/array body (the chat-completions shape)', () => {
    const { node, errors } = parseValue(
      { model: '${args.model}', messages: [{ role: 'user', content: '${args.query}' }] },
      'p',
      new Set(['args']),
    );
    expect(errors).toEqual([]);
    expect(node).toEqual({
      kind: 'object',
      entries: [
        {
          key: 'model',
          value: { kind: 'path', root: 'args', segments: [{ kind: 'prop', name: 'model' }] },
        },
        {
          key: 'messages',
          value: {
            kind: 'array',
            items: [
              {
                kind: 'object',
                entries: [
                  { key: 'role', value: { kind: 'literal', value: 'user' } },
                  {
                    key: 'content',
                    value: {
                      kind: 'path',
                      root: 'args',
                      segments: [{ kind: 'prop', name: 'query' }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  it('reports an error at the nested path of a bad leaf expression', () => {
    const { errors } = parseValue({ outer: [{ inner: '${input.x' }] }, 'p');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('invalid_expression');
    expect(errors[0]?.path).toBe('p.outer[0].inner');
  });

  it('rejects structures nested beyond the depth limit', () => {
    let deep: unknown = '${input.x}';
    for (let i = 0; i < 34; i++) deep = [deep];
    expect(parseValue(deep, 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('parses a ?? fallback into a coalesce node (path left, literal right)', () => {
    const { node, errors } = parseValue('${args.model ?? "sonar"}', 'p', new Set(['args']));
    expect(errors).toEqual([]);
    expect(node).toEqual({
      kind: 'coalesce',
      left: { kind: 'path', root: 'args', segments: [{ kind: 'prop', name: 'model' }] },
      right: { kind: 'literal', value: 'sonar' },
    });
  });

  it('chains ?? left-associatively', () => {
    const { node, errors } = parseValue('${input.a ?? input.b ?? "d"}', 'p');
    expect(errors).toEqual([]);
    // ((a ?? b) ?? "d")
    expect(node).toEqual({
      kind: 'coalesce',
      left: {
        kind: 'coalesce',
        left: { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'a' }] },
        right: { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'b' }] },
      },
      right: { kind: 'literal', value: 'd' },
    });
  });

  it('allows a path on the right of ??', () => {
    const { node, errors } = parseValue('${input.a ?? input.b}', 'p');
    expect(errors).toEqual([]);
    expect(node).toMatchObject({ kind: 'coalesce', right: { kind: 'path' } });
  });

  it('still rejects comparison/boolean operators in value position', () => {
    expect(parseValue('${input.x === input.y}', 'p').errors[0]?.code).toBe(
      'expr_operator_not_allowed',
    );
    expect(parseValue('${input.x && input.y}', 'p').errors[0]?.code).toBe(
      'expr_operator_not_allowed',
    );
  });

  it('rejects a single ? (only ?? is a fallback)', () => {
    expect(parseValue('${input.x ? input.y}', 'p').errors[0]?.code).toBe('invalid_expression');
  });

  it('parses ?? inside a string template', () => {
    const { node, errors } = parseValue('model=${args.model ?? "sonar"}!', 'p', new Set(['args']));
    expect(errors).toEqual([]);
    expect(node).toMatchObject({
      kind: 'template',
      parts: [
        { kind: 'text', value: 'model=' },
        { kind: 'coalesce' },
        { kind: 'text', value: '!' },
      ],
    });
  });

  it('parses allowlisted locale-aware formatter function calls', () => {
    const { node, errors } = parseValue('${formatCurrency(input.total, "USD", "de-DE")}', 'p');
    expect(errors).toEqual([]);
    expect(node).toEqual({
      kind: 'function',
      name: 'formatCurrency',
      args: [
        { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'total' }] },
        { kind: 'literal', value: 'USD' },
        { kind: 'literal', value: 'de-DE' },
      ],
    });
    expect(parseValue('${formatNumber(input.total, "ja-JP")}', 'p').node).toMatchObject({
      kind: 'function',
      name: 'formatNumber',
    });
    expect(
      parseValue(
        '${formatDateTime(input.startsAt, "en-GB", "short", "short", "Europe/London")}',
        'p',
      ).node,
    ).toMatchObject({ kind: 'function', name: 'formatDateTime' });
    expect(parseValue('${formatRelativeTime(input.days, "day", "en-US")}', 'p').node).toMatchObject(
      {
        kind: 'function',
        name: 'formatRelativeTime',
      },
    );
    expect(parseValue('${formatUnit(input.weight, "kilometer", "de-DE")}', 'p').node).toMatchObject(
      {
        kind: 'function',
        name: 'formatUnit',
      },
    );
    expect(
      parseValue('${formatPlural(input.count, "en-US", "1 item", "items")}', 'p').node,
    ).toMatchObject({ kind: 'function', name: 'formatPlural' });
  });

  it('rejects the removed formatDate helper', () => {
    expect(parseValue('${formatDate(input.date)}', 'p').errors[0]).toMatchObject({
      code: 'invalid_expression',
      message: "function 'formatDate' is not allowed",
    });
  });

  it('rejects non-allowlisted functions', () => {
    expect(parseValue('${danger(input.x)}', 'p').errors[0]).toMatchObject({
      code: 'invalid_expression',
      path: 'p',
    });
  });

  it('collectPaths walks into nested arrays and objects', () => {
    const { node } = parseValue(
      { messages: [{ content: '${args.query}' }], model: '${args.model}' },
      'p',
      new Set(['args']),
    );
    const roots = collectPaths(node).map((p) =>
      p.segments.map((s) => ('name' in s ? s.name : s.value)).join('.'),
    );
    expect(roots.sort()).toEqual(['model', 'query']);
  });
});
describe('parseCondition', () => {
  it('a bare path is truthiness', () => {
    expect(parseCondition('${input.is_active}', 'p').node).toEqual({
      kind: 'truthy',
      operand: { kind: 'path', root: 'input', segments: [{ kind: 'prop', name: 'is_active' }] },
    });
  });

  it('parses equality against a literal', () => {
    const { node } = parseCondition('${steps.lookup.status === "shipped"}', 'p');
    expect(node).toEqual({
      kind: 'cond',
      op: 'eq',
      left: {
        kind: 'path',
        root: 'steps',
        segments: [
          { kind: 'prop', name: 'lookup' },
          { kind: 'prop', name: 'status' },
        ],
      },
      right: { kind: 'literal', value: 'shipped' },
    });
  });

  it('honors precedence: || < && and binds !==/=== tightest', () => {
    const { node } = parseCondition('${input.x === 1 && input.y !== 2 || input.z}', 'p');
    // Top level is the || of (=== && !==) and (truthy input.z)
    expect(node).toMatchObject({ kind: 'cond', op: 'or' });
  });

  it('parses negation and grouping', () => {
    const { node } = parseCondition('${!(input.a === input.b)}', 'p');
    expect(node).toMatchObject({ kind: 'cond', op: 'not', operand: { kind: 'cond', op: 'eq' } });
  });

  it('rejects a bare literal as not boolean', () => {
    expect(parseCondition('${42}', 'p').errors[0]?.code).toBe('expr_if_not_boolean');
  });

  it('rejects a non-string condition as not boolean', () => {
    expect(parseCondition(true, 'p').errors[0]?.code).toBe('expr_if_not_boolean');
  });

  it('rejects a plain (non-expression) string', () => {
    expect(parseCondition('shipped', 'p').errors[0]?.code).toBe('expr_if_not_boolean');
  });

  it('rejects a template (surrounding text) as not boolean', () => {
    expect(parseCondition('x ${a.b}', 'p').errors[0]?.code).toBe('expr_if_not_boolean');
  });

  it('rejects loose equality with a helpful message', () => {
    const { errors } = parseCondition('${a.b == c.d}', 'p');
    expect(errors[0]?.code).toBe('invalid_expression');
  });

  it('rejects deferred roots distinctly in conditions', () => {
    for (const root of ['item']) {
      expect(parseCondition(`\${${root}.id}`, 'p').errors[0]?.code).toBe('expr_root_unavailable');
    }
  });

  it('rejects overly large condition strings', () => {
    expect(parseCondition('x'.repeat(16_385), 'p').errors[0]).toMatchObject({
      code: 'invalid_expression',
      path: 'p',
    });
    expect(parseCondition(`\${${'input.'.repeat(3000)}x}`, 'p').errors[0]?.code).toBe(
      'invalid_expression',
    );
  });

  it('allows condition strings exactly at the size limit', () => {
    const condition = `\${input.${'a'.repeat(16_375)}}`;
    expect(condition.length).toBe(16_384);
    expect(parseCondition(condition, 'p').errors).toEqual([]);
  });
});

describe('collectPaths', () => {
  it('gathers paths from a condition', () => {
    const { node } = parseCondition('${steps.a.x === steps.b.y && input.z}', 'p');
    const roots = collectPaths(node).map((p) => `${p.root}.${p.segments[0]?.name}`);
    expect(roots).toEqual(['steps.a', 'steps.b', 'input.z']);
  });

  it('gathers paths from a template', () => {
    const { node } = parseValue('${input.a}-${steps.b.c}', 'p');
    expect(collectPaths(node).map((p) => p.root)).toEqual(['input', 'steps']);
  });
});

describe('expression parser/tokenizer edge cases', () => {
  it('rejects malformed logical and equality operators', () => {
    expect(parseValue('${input.x & input.y}', 'p').errors[0]?.message).toContain(
      "use '&&' for logical and",
    );
    expect(parseValue('${input.x | input.y}', 'p').errors[0]?.message).toContain(
      "use '||' for logical or",
    );
    expect(parseValue('${input.x = input.y}', 'p').errors[0]?.message).toContain(
      "use '===' for equality",
    );
  });

  it('rejects unexpected characters in expressions', () => {
    expect(parseValue('${input.x % input.y}', 'p').errors[0]?.message).toContain(
      "unexpected character '%'",
    );
  });

  it('rejects invalid array index patterns', () => {
    expect(parseValue('${steps.search.items[-1]}', 'p').errors[0]?.message).toContain(
      'array index must be a non-negative integer',
    );
    expect(parseValue('${steps.search.items[1.5]}', 'p').errors[0]?.message).toContain(
      'array index must be a non-negative integer',
    );
    expect(parseValue('${steps.search.items[abc]}', 'p').errors[0]?.message).toContain(
      'expected number',
    );
  });
});

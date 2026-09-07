import { type ComputeLimits, DEFAULT_LIMITS, QuickJsComputeEngine } from '@noodle-borg/compute';
import { describe, expect, it } from 'vitest';

/** Compile `source` and run it once against `input`. */
async function run(
  source: string,
  input: unknown,
  limits: Partial<ComputeLimits> = {},
): Promise<unknown> {
  const engine = new QuickJsComputeEngine();
  const module = await engine.compile(source);
  const instance = await engine.instantiate(module);
  try {
    return await instance.invoke(input, { ...DEFAULT_LIMITS, ...limits });
  } finally {
    instance.dispose();
  }
}

describe('compute scenarios — varied handler shapes', () => {
  it('numeric stats over an array input', async () => {
    const src = `(input) => {
      const xs = input.values;
      const sum = xs.reduce((a, b) => a + b, 0);
      return { sum, mean: sum / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
    }`;
    expect(await run(src, { values: [3, 1, 4, 1, 5, 9, 2, 6] })).toEqual({
      sum: 31,
      mean: 3.875,
      min: 1,
      max: 9,
    });
  });

  it('regex extraction returning an array', async () => {
    const src = `(input) => ({ emails: String(input.text).match(/[\\w.]+@[\\w.]+/g) || [] })`;
    expect(await run(src, { text: 'ping a@b.com and y@z.org please' })).toEqual({
      emails: ['a@b.com', 'y@z.org'],
    });
  });

  it('recursion (fibonacci) within limits', async () => {
    const src = `(input) => {
      const fib = (n) => (n < 2 ? n : fib(n - 1) + fib(n - 2));
      return { result: fib(input.n) };
    }`;
    expect(await run(src, { n: 10 })).toEqual({ result: 55 });
  });

  it('group-by over an array of objects (nested input + nested output)', async () => {
    const src = `(input) => {
      const groups = {};
      for (const row of input.rows) {
        if (!groups[row.team]) groups[row.team] = [];
        groups[row.team].push(row.name);
      }
      return { groups };
    }`;
    const rows = [
      { team: 'a', name: 'x' },
      { team: 'b', name: 'y' },
      { team: 'a', name: 'z' },
    ];
    expect(await run(src, { rows })).toEqual({ groups: { a: ['x', 'z'], b: ['y'] } });
  });

  it('conditional output shape based on input', async () => {
    const src = `(input) =>
      input.op === 'sum' ? { sum: input.a + input.b } : { product: input.a * input.b }`;
    expect(await run(src, { op: 'sum', a: 2, b: 5 })).toEqual({ sum: 7 });
    expect(await run(src, { op: 'mul', a: 2, b: 5 })).toEqual({ product: 10 });
  });

  it('handles an empty array input without crashing', async () => {
    const src = `(input) => ({ count: input.values.length, empty: input.values.length === 0 })`;
    expect(await run(src, { values: [] })).toEqual({ count: 0, empty: true });
  });

  it('reads nested object input and returns nested fields', async () => {
    const src = `(input) => ({
      full: input.user.first + ' ' + input.user.last,
      city: input.user.address.city,
    })`;
    const user = { first: 'Ada', last: 'Lovelace', address: { city: 'London' } };
    expect(await run(src, { user })).toEqual({ full: 'Ada Lovelace', city: 'London' });
  });

  it('round-trips unicode and emoji through JSON marshaling', async () => {
    const src = `(input) => ({ echoed: input.s, points: [...input.s].length })`;
    expect(await run(src, { s: 'café 🚀' })).toEqual({ echoed: 'café 🚀', points: 6 });
  });

  it('preserves booleans, null, and nested arrays in output', async () => {
    const src = `(input) => ({ flag: !input.flag, nested: [[1, 2], [3]], nothing: null })`;
    expect(await run(src, { flag: true })).toEqual({
      flag: false,
      nested: [[1, 2], [3]],
      nothing: null,
    });
  });

  it('sorts and de-duplicates a list', async () => {
    const src = `(input) => ({ sorted: [...new Set(input.items)].sort() })`;
    expect(await run(src, { items: ['b', 'a', 'b', 'c', 'a'] })).toEqual({
      sorted: ['a', 'b', 'c'],
    });
  });

  it('completes a bounded heavy loop within the default time budget', async () => {
    const src = `(input) => {
      let s = 0;
      for (let i = 0; i < input.n; i++) s += i;
      return { sum: s };
    }`;
    expect(await run(src, { n: 100000 })).toEqual({ sum: 4999950000 });
  });

  it('supports a function-expression handler (not only arrows)', async () => {
    const src = `function (input) { return { shout: String(input.s).toUpperCase() }; }`;
    expect(await run(src, { s: 'hello' })).toEqual({ shout: 'HELLO' });
  });
});

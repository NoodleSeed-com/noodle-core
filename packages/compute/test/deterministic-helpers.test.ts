import { createHash } from 'node:crypto';
import { DEFAULT_LIMITS, QuickJsComputeEngine } from '@noodle-borg/compute';
import { describe, expect, it } from 'vitest';

async function run(source: string, input: unknown = {}) {
  const engine = new QuickJsComputeEngine();
  const instance = await engine.instantiate(await engine.compile(source));
  try {
    return await instance.invoke(input, { ...DEFAULT_LIMITS, timeoutMs: 2_000 });
  } finally {
    instance.dispose();
  }
}

describe('explicit deterministic compute helpers', () => {
  it('converts supplied instants without restoring a clock or host globals', async () => {
    expect(
      await run(`(_, host) => ({
      epoch: host.time.parse('2026-11-01T09:30:00Z'),
      iso: host.time.format(1793525400000),
      local: host.time.parts(1793525400000, 'America/Los_Angeles'),
      date: typeof Date, intl: typeof Intl, random: typeof Math.random,
      process: typeof process, fetch: typeof fetch
    })`),
    ).toEqual({
      epoch: 1793525400000,
      iso: '2026-11-01T09:30:00.000Z',
      local: { date: '2026-11-01', weekday: 7, hour: 1, minute: 30 },
      date: 'undefined',
      intl: 'undefined',
      random: 'undefined',
      process: 'undefined',
      fetch: 'undefined',
    });
  });

  it('handles both sides of a daylight saving change using the explicit instant', async () => {
    expect(
      await run(`(_, host) => ['2026-03-08T09:30:00Z', '2026-03-08T10:30:00Z']
      .map(value => host.time.parts(host.time.parse(value), 'America/Los_Angeles'))`),
    ).toEqual([
      { date: '2026-03-08', weekday: 7, hour: 1, minute: 30 },
      { date: '2026-03-08', weekday: 7, hour: 3, minute: 30 },
    ]);
  });

  it.each([
    "host.time.parse('now')",
    "host.time.parse('2026-02-30T00:00:00Z')",
    "host.time.parse('2026-09-01')",
    'host.time.format(Infinity)',
    "host.time.parts(0, 'not/a-zone')",
    "host.digest('x', 'unsupported')",
    "host.digest('x'.repeat(8193))",
  ])('rejects invalid or unbounded helper input: %s', async (expression) => {
    await expect(run(`(_, host) => ${expression}`)).rejects.toMatchObject({
      code: 'runtime_error',
    });
  });

  it('hashes only explicit bounded input and preserves SHA256 compatibility', async () => {
    expect(await run(`(input, host) => host.digest(input.value)`, { value: 'operation-123' })).toBe(
      createHash('sha256').update('operation-123').digest('hex'),
    );
    expect(await run(`(_, host) => host.digest('operation-123', 'base32hex')`)).toMatch(
      /^[0-9a-v]{52}$/,
    );
  });

  it('exposes only explicit trusted identity and coordination fields', async () => {
    const engine = new QuickJsComputeEngine();
    const instance = await engine.instantiate(
      await engine.compile(
        '(_, host) => ({ execution: host.execution, coordination: host.coordination })',
      ),
    );
    const trusted = { id: 'trusted-operation', secret: 'must-not-cross' };
    const previous = {
      reference: 'opaque-resource',
      operationDigest: 'a'.repeat(64),
      otherSecret: 'must-not-cross',
    };
    expect(
      await instance.invoke({ execution: { id: 'untrusted' } }, DEFAULT_LIMITS, {
        execution: trusted,
        coordination: { acquired: false, previous },
        callOperation: async () => null,
      }),
    ).toEqual({
      execution: { id: 'trusted-operation' },
      coordination: {
        acquired: false,
        previous: { reference: 'opaque-resource', operationDigest: 'a'.repeat(64) },
      },
    });
    instance.dispose();
  });

  it('bounds host helper calls independently of tenant loops', async () => {
    await expect(
      run(`(_, host) => { for (let i = 0; i < 5000; i++) host.time.format(0); }`),
    ).rejects.toMatchObject({ code: 'runtime_error' });
  });
});

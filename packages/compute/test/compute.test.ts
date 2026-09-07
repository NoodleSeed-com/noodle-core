import {
  CodeConnector,
  ComputeError,
  type ComputeHost,
  type ComputeLimits,
  DEFAULT_LIMITS,
  QuickJsComputeEngine,
} from '@noodle-borg/compute';
import type { ConnectorCall, ConnectorCallHost, DownstreamCredential } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';

const CREDENTIAL: DownstreamCredential = { token: '' };

/** Compile `source` and run it once against `input`. */
async function run(
  source: string,
  input: unknown,
  limits: Partial<ComputeLimits> = {},
  host?: ComputeHost,
): Promise<unknown> {
  const engine = new QuickJsComputeEngine();
  const module = await engine.compile(source);
  const instance = await engine.instantiate(module);
  try {
    return await instance.invoke(input, { ...DEFAULT_LIMITS, ...limits }, host);
  } finally {
    instance.dispose();
  }
}

describe('QuickJsComputeEngine', () => {
  it('runs a pure transform and marshals JSON in/out', async () => {
    const out = await run('(input) => ({ doubled: input.n * 2 })', { n: 21 });
    expect(out).toEqual({ doubled: 42 });
  });

  it('supports logic the expression language cannot (regex + iteration)', async () => {
    const slug = `(input) => {
      const base = String(input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      let s = base; while (s.startsWith('-')) s = s.slice(1);
      while (s.endsWith('-')) s = s.slice(0, -1);
      return { slug: s };
    }`;
    expect(await run(slug, { title: 'Hello, World! 2026' })).toEqual({ slug: 'hello-world-2026' });
  });

  it('grants no ambient authority (no fetch/process/require/globalThis host bindings)', async () => {
    const probe = `(input) => ({
      fetch: typeof fetch,
      console: typeof console,
      process: typeof process,
      require: typeof require,
      global: typeof global,
      globalThisFetch: typeof globalThis.fetch,
    })`;
    expect(await run(probe, {})).toEqual({
      fetch: 'undefined',
      console: 'undefined',
      process: 'undefined',
      require: 'undefined',
      global: 'undefined',
      globalThisFetch: 'undefined',
    });
  });

  it('neutralizes nondeterministic globals (Date, Math.random)', async () => {
    const probe = '(input) => ({ date: typeof Date, random: typeof Math.random })';
    expect(await run(probe, {})).toEqual({ date: 'undefined', random: 'undefined' });
  });

  it('fails closed on an infinite loop (timeout)', async () => {
    await expect(
      run('(input) => { while (true) {} }', {}, { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('fails closed when memory is exhausted', async () => {
    const hog =
      '(input) => { const a = []; for (let i = 0; i < 1e9; i++) a.push(new Array(10000)); return a.length; }';
    const err = await run(hog, {}, { timeoutMs: 2000, memoryBytes: 1 << 20 }).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe('memory');
  });

  it('fails closed when output exceeds the size cap', async () => {
    await expect(
      run('(input) => "x".repeat(100000)', {}, { maxOutputBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'output_too_large' });
  });

  it('surfaces a syntax error as a typed ComputeError', async () => {
    const err = await run('(input) => (', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe('runtime_error');
  });

  it('rejects a module that does not evaluate to a function', async () => {
    const err = await run('42', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe('runtime_error');
  });

  it('produces a stable content-addressed digest', async () => {
    const engine = new QuickJsComputeEngine();
    const a = await engine.compile('(input) => input');
    const b = await engine.compile('(input) => input');
    const c = await engine.compile('(input) => input.x');
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('lets handlers call a host-mediated operation', async () => {
    const host: ComputeHost = {
      callOperation: async (name, args) => ({ name, echoed: args.value }),
    };

    await expect(
      run(
        '(input) => ({ result: callOperation("echo", { value: input.value }) })',
        { value: 'hi' },
        {},
        host,
      ),
    ).resolves.toEqual({ result: { name: 'echo', echoed: 'hi' } });
  });

  it('captures sandbox console output only through an explicit host log sink', async () => {
    const logs: Array<{ level: string; message: string }> = [];
    const host: ComputeHost = {
      callOperation: async () => ({ ok: true }),
      log: (entry) => logs.push({ level: entry.level, message: entry.message }),
    };

    await expect(
      run(
        `(input) => {
          console.log("hello", input.name, { token: "secret" });
          console.warn("careful");
          return { ok: true };
        }`,
        { name: 'Grace' },
        {},
        host,
      ),
    ).resolves.toEqual({ ok: true });

    expect(logs).toEqual([
      { level: 'info', message: 'hello Grace [unloggable]' },
      { level: 'warn', message: 'careful' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret');
  });

  it('bounds sandbox console output before it leaves the sandbox', async () => {
    const logs: Array<{ level: string; message: string; truncated?: boolean }> = [];
    const host: ComputeHost = {
      callOperation: async () => ({ ok: true }),
      log: (entry) =>
        logs.push({ level: entry.level, message: entry.message, truncated: entry.truncated }),
    };

    await run('() => { console.error("x".repeat(5000)); return {}; }', {}, {}, host);

    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe('error');
    expect(logs[0]?.truncated).toBe(true);
    expect(logs[0]?.message.length).toBeLessThanOrEqual(1024);
  });

  it('supports sequential host calls in one handler', async () => {
    const seen: string[] = [];
    const host: ComputeHost = {
      callOperation: async (name, args) => {
        seen.push(`${name}:${String(args.value)}`);
        return { value: `${String(args.value)}!` };
      },
    };

    await expect(
      run(
        `(input) => {
          const first = callOperation("append", { value: input.value });
          const second = callOperation("append", { value: first.value });
          return { final: second.value };
        }`,
        { value: 'hi' },
        {},
        host,
      ),
    ).resolves.toEqual({ final: 'hi!!' });
    expect(seen).toEqual(['append:hi', 'append:hi!']);
  });

  it('also exposes callOperation on the second handler argument', async () => {
    const host: ComputeHost = {
      callOperation: async (_name, args) => ({ doubled: Number(args.n) * 2 }),
    };

    await expect(
      run(
        '(input, host) => ({ out: host.callOperation("double", { n: input.n }) })',
        { n: 7 },
        {},
        host,
      ),
    ).resolves.toEqual({ out: { doubled: 14 } });
  });

  it('fails closed when the host-call budget is exceeded', async () => {
    const host: ComputeHost = {
      callOperation: async () => ({ ok: true }),
    };

    await expect(
      run(
        '() => { callOperation("x", {}); callOperation("x", {}); return {}; }',
        {},
        { maxHostCalls: 1 },
        host,
      ),
    ).rejects.toMatchObject({ code: 'host_call_denied' });
  });

  it('rejects host-call arguments that are not JSON object containers', async () => {
    const host: ComputeHost = {
      callOperation: async () => ({ ok: true }),
    };

    await expect(run('() => callOperation("x", ["bad"])', {}, {}, host)).rejects.toMatchObject({
      code: 'host_call_denied',
      message: 'host call arguments must be an object',
    });
    await expect(run('() => callOperation("x", "bad")', {}, {}, host)).rejects.toMatchObject({
      code: 'host_call_denied',
      message: 'host call arguments must be an object',
    });
  });

  it('normalizes and truncates host failures before they re-enter sandbox code', async () => {
    const host: ComputeHost = {
      callOperation: async () => {
        const err = new Error(`backend secret ${'x'.repeat(500)}`) as Error & {
          code?: string;
          path?: string;
        };
        err.code = 'host_call_failed';
        err.path = 'secret.path';
        throw err;
      },
    };

    const err = await run('() => callOperation("x", {})', {}, {}, host).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeError);
    expect((err as ComputeError).code).toBe('host_call_failed');
    expect((err as ComputeError).message).toHaveLength(256);
  });

  it('does not expose callOperation when no host is provided', async () => {
    await expect(run('() => callOperation("x", {})', {})).rejects.toMatchObject({
      code: 'runtime_error',
    });
  });
});

describe('CodeConnector', () => {
  it('exposes the declared signature and runs the module on invoke', async () => {
    const engine = new QuickJsComputeEngine();
    const module = await engine.compile('(input) => ({ sum: input.a + input.b })');
    const connector = new CodeConnector({
      id: 'calc',
      version: '1.0.0',
      engine,
      operations: {
        add: {
          signature: {
            type: 'read',
            input: { a: { type: 'number' }, b: { type: 'number' } },
            output: { sum: { type: 'number' } },
          },
          module,
        },
      },
    });

    expect(connector.signature('add')?.output).toEqual({ sum: { type: 'number' } });
    expect(connector.signature('missing')).toBeUndefined();

    const call: ConnectorCall = { operation: 'add', args: { a: 2, b: 3 }, credential: CREDENTIAL };
    expect(await connector.invoke(call)).toEqual({ sum: 5 });
  });

  it('enforces declared host-call names before delegating to the runtime host', async () => {
    const engine = new QuickJsComputeEngine();
    const module = await engine.compile(
      '() => ({ value: callOperation("allowed", { id: "A1" }) })',
    );
    const host: ConnectorCallHost = {
      callOperation: async (_ref, args) => ({ order: args.id }),
    };
    const connector = new CodeConnector({
      id: 'compute',
      version: '1.0.0',
      engine,
      operations: {
        run: {
          signature: { type: 'read', input: {}, output: { value: { type: 'object' } } },
          module,
          calls: {
            allowed: {
              resolved: true,
              alias: 'orders',
              connectorId: 'orders',
              connectorVersion: '1.0.0',
              operation: 'get_order',
              signatureHash: 'sha256:test',
            },
          },
        },
      },
    });

    await expect(
      connector.invoke({ operation: 'run', args: {}, credential: CREDENTIAL, host }),
    ).resolves.toEqual({ value: { order: 'A1' } });
  });

  it('rejects undeclared host-call names', async () => {
    const engine = new QuickJsComputeEngine();
    const module = await engine.compile('() => callOperation("missing", {})');
    const connector = new CodeConnector({
      id: 'compute',
      version: '1.0.0',
      engine,
      operations: {
        run: {
          signature: { type: 'read', input: {}, output: {} },
          module,
          calls: {},
        },
      },
    });

    await expect(
      connector.invoke({
        operation: 'run',
        args: {},
        credential: CREDENTIAL,
        host: { callOperation: async () => ({}) },
      }),
    ).rejects.toMatchObject({ code: 'host_call_denied' });
  });

  it('throws for an unknown operation', async () => {
    const engine = new QuickJsComputeEngine();
    const connector = new CodeConnector({ id: 'x', version: '1.0.0', engine, operations: {} });
    const call: ConnectorCall = { operation: 'nope', args: {}, credential: CREDENTIAL };
    await expect(connector.invoke(call)).rejects.toThrow(/no operation/);
  });
});

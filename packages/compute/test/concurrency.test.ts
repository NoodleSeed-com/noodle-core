import {
  CodeConnector,
  type ComputeHost,
  type ComputeLimits,
  type ComputeTimings,
  DEFAULT_LIMITS,
  QuickJsComputeEngine,
} from '@noodle-borg/compute';
import {
  type ConnectorCallHost,
  type ConnectorTraceEvent,
  type DownstreamCredential,
  isConnectorInvocationError,
} from '@noodle-borg/runtime';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Regression suite for head-of-line blocking in concurrent compute-backed connector calls
 * (production incident 2026-08-25, issue #1307): concurrent invocations on one runtime instance
 * must have bounded, isolated execution — one slow invocation must not serialize independent
 * invocations behind it, queue wait must count against the call's total budget, and queue wait and
 * execution must be independently timed.
 */

const engines: QuickJsComputeEngine[] = [];

function pooledEngine(options: { maxWorkers?: number; terminateGraceMs?: number }) {
  const engine = new QuickJsComputeEngine(options);
  engines.push(engine);
  return engine;
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
});

async function invokeOn(
  engine: QuickJsComputeEngine,
  source: string,
  input: unknown,
  limits: Partial<ComputeLimits> = {},
  host?: ComputeHost,
  onTimings?: (timings: ComputeTimings) => void,
): Promise<unknown> {
  const module = await engine.compile(source);
  const instance = await engine.instantiate(module);
  try {
    return await instance.invoke(input, { ...DEFAULT_LIMITS, ...limits }, host, onTimings);
  } finally {
    instance.dispose();
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const sleepingHost = (ms: number): ComputeHost => ({
  callOperation: async () => {
    await sleep(ms);
    return { ok: true };
  },
});

/**
 * Spawn `workers` pool workers and load their WASM modules before a timing-sensitive section, so
 * assertions measure execution overlap rather than cold worker boot on a loaded CI runner. The
 * hosted phase additionally loads each worker's asyncified module used by host-call execution;
 * running one phase at a time keeps every worker covered by both.
 */
async function warmUp(
  engine: QuickJsComputeEngine,
  workers: number,
  hosted = false,
): Promise<void> {
  await Promise.all(
    Array.from({ length: workers }, () =>
      invokeOn(engine, '() => ({ ok: true })', {}, { timeoutMs: 30_000 }),
    ),
  );
  if (!hosted) return;
  await Promise.all(
    Array.from({ length: workers }, () =>
      invokeOn(
        engine,
        '() => ({ out: callOperation("warm", {}) })',
        {},
        { timeoutMs: 30_000 },
        sleepingHost(1),
      ),
    ),
  );
}

describe('concurrent compute isolation (issue #1307)', () => {
  it('does not serialize a burst of runaway invocations into duration multiples', async () => {
    const engine = pooledEngine({ maxWorkers: 4 });
    await warmUp(engine, 4);
    const started = Date.now();
    const settled = await Promise.all(
      Array.from({ length: 4 }, () =>
        invokeOn(engine, '() => { while (true) {} }', {}, { timeoutMs: 400 })
          .then(() => ({ code: 'ok', elapsedMs: Date.now() - started }))
          .catch((error: { code?: string }) => ({
            code: error.code,
            elapsedMs: Date.now() - started,
          })),
      ),
    );
    const totalMs = Date.now() - started;

    // Every call fails closed on its own 400ms budget. Before the fix the four calls executed
    // one after another on the host event loop (~400/800/1200/1600ms — the production staircase);
    // the bounds only need to exclude that staircase, not assume an idle machine.
    for (const outcome of settled) {
      expect(outcome.code).toBe('timeout');
      expect(outcome.elapsedMs).toBeLessThan(1200);
    }
    expect(totalMs).toBeLessThan(1400);
  });

  it('keeps the host event loop responsive while tenant compute runs', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    await warmUp(engine, 1);
    let ticks = 0;
    const interval = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await expect(
        invokeOn(engine, '() => { while (true) {} }', {}, { timeoutMs: 500 }),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      clearInterval(interval);
    }
    // A main-thread interpreter blocks the loop for the full 500ms (0–2 ticks). Off-thread
    // execution keeps unrelated work (other requests, health checks) running.
    expect(ticks).toBeGreaterThanOrEqual(10);
  });

  it('overlaps independent host-call-bound invocations instead of queueing them end to end', async () => {
    const engine = pooledEngine({ maxWorkers: 4 });
    await warmUp(engine, 4, true);
    const source = '() => ({ out: callOperation("wait", {}) })';
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        invokeOn(engine, source, {}, { timeoutMs: 10_000 }, sleepingHost(400)),
      ),
    );
    const totalMs = Date.now() - started;

    for (const result of results) expect(result).toEqual({ out: { ok: true } });
    // Serialized execution would take >= 1600ms; concurrent execution is bounded by one sleep
    // plus scheduling overhead on a loaded runner.
    expect(totalMs).toBeLessThan(1200);
  });

  it('fails a queued call fast with a stable queue-timeout classification when its budget expires before execution', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    await warmUp(engine, 1, true);
    // Occupy the only worker well past the queued call's budget.
    const busy = invokeOn(
      engine,
      '() => ({ out: callOperation("wait", {}) })',
      {},
      { timeoutMs: 5000 },
      sleepingHost(400),
    );

    let timings: ComputeTimings | undefined;
    const started = Date.now();
    const error = await invokeOn(
      engine,
      '() => ({ ok: true })',
      {},
      { timeoutMs: 150 },
      undefined,
      (t) => {
        timings = t;
      },
    ).catch((e: { code?: string }) => e);
    const elapsedMs = Date.now() - started;

    // The stable classification and executionMs of exactly 0 prove the call failed from the
    // queue without ever dispatching, instead of running after the worker freed.
    expect(error).toMatchObject({ code: 'queue_timeout' });
    expect(elapsedMs).toBeLessThan(900);
    expect(timings).toBeDefined();
    expect(timings?.queueWaitMs).toBeGreaterThanOrEqual(100);
    expect(timings?.executionMs).toBe(0);

    await expect(busy).resolves.toEqual({ out: { ok: true } });
  });

  it('deducts queue wait from the execution budget so total call time stays bounded', async () => {
    const engine = pooledEngine({ maxWorkers: 1, terminateGraceMs: 100 });
    await warmUp(engine, 1, true);
    const busy = invokeOn(
      engine,
      '() => ({ out: callOperation("wait", {}) })',
      {},
      { timeoutMs: 5000 },
      sleepingHost(300),
    );

    let timings: ComputeTimings | undefined;
    const started = Date.now();
    const error = await invokeOn(
      engine,
      '() => { while (true) {} }',
      {},
      { timeoutMs: 900 },
      undefined,
      (t) => {
        timings = t;
      },
    ).catch((e: { code?: string }) => e);
    const elapsedMs = Date.now() - started;

    // The call waited ~300ms behind the busy worker, so execution had only the remaining budget
    // before failing closed with the execution-timeout classification (it did start executing),
    // and the total stayed bounded by the 900ms budget plus grace.
    expect(error).toMatchObject({ code: 'timeout' });
    expect(elapsedMs).toBeLessThan(2000);
    expect(timings).toBeDefined();
    expect(timings?.queueWaitMs).toBeGreaterThanOrEqual(150);
    expect(timings?.executionMs).toBeLessThanOrEqual(900);

    await expect(busy).resolves.toEqual({ out: { ok: true } });
  });

  it('reports queue-wait and execution durations separately on success', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    await warmUp(engine, 1, true);
    const firstTimings: ComputeTimings[] = [];
    const busy = invokeOn(
      engine,
      '() => ({ out: callOperation("wait", {}) })',
      {},
      { timeoutMs: 5000 },
      sleepingHost(200),
      (t) => firstTimings.push(t),
    );

    let timings: ComputeTimings | undefined;
    const result = await invokeOn(
      engine,
      '(input) => ({ doubled: input.n * 2 })',
      { n: 21 },
      { timeoutMs: 2000 },
      undefined,
      (t) => {
        timings = t;
      },
    );

    expect(result).toEqual({ doubled: 42 });
    expect(timings).toBeDefined();
    expect(timings?.queueWaitMs).toBeGreaterThanOrEqual(120);
    expect(timings?.executionMs).toBeGreaterThanOrEqual(0);

    await expect(busy).resolves.toEqual({ out: { ok: true } });
    expect(firstTimings).toHaveLength(1);
    expect(firstTimings[0]?.queueWaitMs).toBeLessThanOrEqual(80);
  });

  it('terminates an invocation stuck past its deadline inside a hanging host call', async () => {
    const engine = pooledEngine({ maxWorkers: 1, terminateGraceMs: 100 });
    await warmUp(engine, 1, true);
    const hangingHost: ComputeHost = {
      callOperation: () => new Promise(() => {}),
    };

    const started = Date.now();
    const error = await invokeOn(
      engine,
      '() => callOperation("hang", {})',
      {},
      { timeoutMs: 300 },
      hangingHost,
    ).catch((e: { code?: string }) => e);
    const elapsedMs = Date.now() - started;

    // The sandbox is suspended awaiting the host, so the in-sandbox interrupt cannot fire; the
    // pool's deadline backstop must bound the call anyway. Before the fix this hung unboundedly.
    expect(error).toMatchObject({ code: 'timeout' });
    expect(elapsedMs).toBeLessThan(1500);

    // The pool replaces the terminated worker; the engine keeps serving new invocations.
    await expect(
      invokeOn(engine, '(input) => ({ ok: input.n })', { n: 7 }, { timeoutMs: 2000 }),
    ).resolves.toEqual({ ok: 7 });
  });

  it('reuses pool workers across sequential invocations', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    for (let i = 0; i < 3; i += 1) {
      await expect(
        invokeOn(engine, '(input) => ({ seq: input.i })', { i }, { timeoutMs: 2000 }),
      ).resolves.toEqual({ seq: i });
    }
  });

  it('rejects a non-serializable input cleanly and keeps the pool healthy', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    const error = await invokeOn(
      engine,
      '(input) => ({ ok: true })',
      { fn: () => 'not structured-cloneable', big: 1n },
      { timeoutMs: 2000 },
    ).catch((e: { code?: string }) => e);

    // Only JSON strings cross the thread boundary: an unserializable input must fail as a typed
    // compute error before dispatch — never strand a worker slot or crash the queue pump.
    expect(error).toMatchObject({ code: 'runtime_error' });

    // A top-level function or symbol makes JSON.stringify return undefined rather than throw;
    // both must fail with the same pre-dispatch classification instead of reaching a worker.
    for (const hostileInput of [() => 'top-level function', Symbol('top-level symbol')]) {
      const undefinedJson = await invokeOn(engine, '(input) => ({ ok: true })', hostileInput, {
        timeoutMs: 2000,
      }).catch((e: { code?: string }) => e);
      expect(undefinedJson).toMatchObject({ code: 'runtime_error' });
    }

    await expect(
      invokeOn(engine, '(input) => ({ ok: input.n })', { n: 3 }, { timeoutMs: 2000 }),
    ).resolves.toEqual({ ok: 3 });
  });
});

const CREDENTIAL: DownstreamCredential = { token: '' };

const WAIT_CALL_REF = {
  resolved: true,
  alias: 'clock',
  connectorId: 'clock',
  connectorVersion: '1.0.0',
  operation: 'wait',
  signatureHash: 'sha256:test',
} as const;

async function slowCallConnector(engine: QuickJsComputeEngine, timeoutMs: number) {
  const slow = await engine.compile('() => ({ out: callOperation("wait", {}) })');
  const quick = await engine.compile('(input) => ({ ok: true })');
  const runaway = await engine.compile('() => { while (true) {} }');
  const signature = { type: 'read', input: {}, output: {} } as const;
  return new CodeConnector({
    id: 'compute',
    version: '1.0.0',
    engine,
    operations: {
      slow: {
        signature,
        module: slow,
        limits: { ...DEFAULT_LIMITS, timeoutMs: 5000 },
        calls: { wait: WAIT_CALL_REF },
      },
      quick: { signature, module: quick, limits: { ...DEFAULT_LIMITS, timeoutMs } },
      runaway: { signature, module: runaway, limits: { ...DEFAULT_LIMITS, timeoutMs } },
    },
  });
}

const waitingHost = (ms: number): ConnectorCallHost => ({
  callOperation: async () => {
    await sleep(ms);
    return { ok: true };
  },
});

describe('CodeConnector timeout classification and timings (issue #1307)', () => {
  it('classifies an execution timeout as a connector timeout failure with independent durations', async () => {
    const engine = pooledEngine({ maxWorkers: 1, terminateGraceMs: 100 });
    const connector = await slowCallConnector(engine, 300);

    const error: unknown = await connector
      .invoke({ operation: 'runaway', args: {}, credential: CREDENTIAL })
      .catch((e: unknown) => e);

    expect(isConnectorInvocationError(error)).toBe(true);
    expect(error).toMatchObject({ category: 'timeout', attempts: 1 });
    const timed = error as { queueWaitMs?: number; executionMs?: number };
    expect(timed.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(timed.executionMs).toBeGreaterThanOrEqual(1);
  });

  it('classifies a queue-expired call as a retryable queue timeout', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    const connector = await slowCallConnector(engine, 150);
    const busy = connector.invoke({
      operation: 'slow',
      args: {},
      credential: CREDENTIAL,
      host: waitingHost(400),
    });

    const error: unknown = await connector
      .invoke({ operation: 'quick', args: {}, credential: CREDENTIAL })
      .catch((e: unknown) => e);

    expect(isConnectorInvocationError(error)).toBe(true);
    expect(error).toMatchObject({ category: 'queue_timeout', attempts: 1, retryable: true });
    const timed = error as { queueWaitMs?: number; executionMs?: number };
    expect(timed.queueWaitMs).toBeGreaterThanOrEqual(100);
    expect(timed.executionMs).toBe(0);

    await expect(busy).resolves.toEqual({ out: { ok: true } });
  });

  it('records queue-wait and execution durations on successful calls through the call trace sink', async () => {
    const engine = pooledEngine({ maxWorkers: 1 });
    const connector = await slowCallConnector(engine, 2000);
    const events: ConnectorTraceEvent[] = [];

    await expect(
      connector.invoke({
        operation: 'quick',
        args: {},
        credential: CREDENTIAL,
        trace: { record: (event) => events.push(event) },
      }),
    ).resolves.toEqual({ ok: true });

    expect(events).toEqual([
      {
        kind: 'connector',
        connectorId: 'compute',
        connectorVersion: '1.0.0',
        operation: 'quick',
        queueWaitMs: expect.any(Number),
        executionMs: expect.any(Number),
      },
    ]);
  });
});

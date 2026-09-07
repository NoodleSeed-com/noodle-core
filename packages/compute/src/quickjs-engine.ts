import {
  type ComputeEngine,
  ComputeError,
  type ComputeHost,
  type ComputeInstance,
  type ComputeLimits,
  type ComputeModule,
  type ComputeTimings,
  digestSource,
} from './engine.js';
import { hostErrorEnvelope } from './sandbox-eval.js';
import {
  ComputeWorkerPool,
  type ComputeWorkerPoolOptions,
  type PoolHostBridge,
  sharedComputeWorkerPool,
} from './worker-pool.js';

/**
 * The first {@link ComputeEngine} backend: a QuickJS interpreter compiled to WebAssembly
 * (`quickjs-emscripten`). It runs tenant-authored JavaScript with **no ambient authority** — a fresh
 * QuickJS runtime per invocation, configured with nothing injected (no `fetch`, `console`, `process`,
 * `require`, or other host bindings), nondeterministic globals removed (`Date`, `Math.random`), and hard,
 * fail-closed bounds (wall-clock timeout, memory cap, output-size cap).
 *
 * Execution happens on a bounded {@link ComputeWorkerPool} of worker threads rather than the main
 * event loop, so one slow invocation cannot serialize independent invocations behind it or starve
 * unrelated requests on the instance (issue #1307). The `timeoutMs` budget covers queue wait plus
 * execution, and both durations are reported independently through the invoke `onTimings` callback.
 *
 * The unit of code is **a JavaScript expression that evaluates to a function** `fn(input) -> output`
 * (e.g. `(input) => { ... }`). Input is JSON-marshaled in, output JSON-marshaled out — the boundary never
 * shares object references. When a host is provided, `callOperation` is the only injected capability and
 * routes through the runtime's policy/broker/connector path.
 *
 * "Interpreter, code-as-data" is the dev-mode backend; the production AOT backend (extism/wasmtime, true
 * instruction-fuel) plugs in behind the same {@link ComputeEngine} interface
 * ([ADR 0014](../../../docs/decisions/0014-compute-engine-interface.md)).
 */
export class QuickJsComputeEngine implements ComputeEngine {
  readonly kind = 'interpreter' as const;
  readonly #sources = new Map<string, string>();
  readonly #pool: ComputeWorkerPool;
  readonly #ownsPool: boolean;

  /**
   * With no options the engine shares the process-wide worker pool, so many per-deployment engines
   * stay within one bounded worker set. Passing options creates a private pool owned (and closed)
   * by this engine.
   */
  constructor(options?: ComputeWorkerPoolOptions) {
    if (options === undefined) {
      this.#pool = sharedComputeWorkerPool();
      this.#ownsPool = false;
    } else {
      this.#pool = new ComputeWorkerPool(options);
      this.#ownsPool = true;
    }
  }

  /** Hash and retain the source. (An AOT backend would emit and store a WASM module here instead.) */
  async compile(source: string): Promise<ComputeModule> {
    return this.registerSource(source);
  }

  /**
   * Synchronous content-addressing for the interpreter backend (hash + retain). Lets a synchronous
   * caller (the connector-catalog compiler) register sources without going async; the AOT backend, whose
   * compile genuinely does work, exposes only the async {@link compile}.
   */
  registerSource(source: string): ComputeModule {
    const digest = digestSource(source);
    this.#sources.set(digest, source);
    return { digest, engine: 'interpreter' };
  }

  async instantiate(module: ComputeModule): Promise<ComputeInstance> {
    const source = this.#sources.get(module.digest);
    if (source === undefined) {
      throw new ComputeError('unknown_module', `no source registered for module ${module.digest}`);
    }
    return new QuickJsComputeInstance(this.#pool, source);
  }

  /** Terminate a private pool's workers; a shared-pool engine has nothing to close. */
  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.close();
  }
}

/** A runnable instance: each {@link invoke} runs on a fresh QuickJS runtime in a pool worker. */
class QuickJsComputeInstance implements ComputeInstance {
  readonly #pool: ComputeWorkerPool;
  readonly #source: string;

  constructor(pool: ComputeWorkerPool, source: string) {
    this.#pool = pool;
    this.#source = source;
  }

  invoke(
    input: unknown,
    limits: ComputeLimits,
    host?: ComputeHost,
    onTimings?: (timings: ComputeTimings) => void,
  ): Promise<unknown> {
    // Serialize before submission: only JSON strings cross the thread boundary, and a hostile
    // input must fail as a typed error here — never strand a worker slot or crash the queue pump.
    // JSON.stringify returns undefined (not a string) for a top-level function or symbol.
    let inputJson: string;
    try {
      inputJson = JSON.stringify(input ?? null);
    } catch {
      return Promise.reject(
        new ComputeError('runtime_error', 'compute input is not JSON-serializable'),
      );
    }
    if (typeof inputJson !== 'string') {
      return Promise.reject(
        new ComputeError('runtime_error', 'compute input is not JSON-serializable'),
      );
    }
    return this.#pool.execute({
      source: this.#source,
      inputJson,
      limits,
      ...(host === undefined ? {} : { host: envelopeBridge(host) }),
      consoleEnabled: host?.log !== undefined,
      ...(onTimings === undefined ? {} : { onTimings }),
    });
  }

  dispose(): void {
    // No retained per-instance resources; runtimes live and die inside the pool workers.
  }
}

/**
 * Adapt a {@link ComputeHost} to the pool's JSON-string bridge: parse the sandbox's argument JSON,
 * run the host capability, and serialize the result (or a bounded, truncated failure) as the
 * envelope the sandbox prelude understands. Host state never crosses in object form.
 */
function envelopeBridge(host: ComputeHost): PoolHostBridge {
  return {
    async callOperation(name, argsJson) {
      const envelope = await (async () => {
        try {
          const args = JSON.parse(argsJson) as Record<string, unknown>;
          return { ok: true as const, output: await host.callOperation(name, args) };
        } catch (error) {
          return hostErrorEnvelope(error);
        }
      })();
      try {
        return JSON.stringify(envelope);
      } catch {
        return JSON.stringify({
          ok: false,
          error: { code: 'host_call_failed', message: 'host call output is not serializable' },
        });
      }
    },
    ...(host.log === undefined
      ? {}
      : {
          log: async (entry) => {
            await host.log?.(entry);
          },
        }),
  };
}

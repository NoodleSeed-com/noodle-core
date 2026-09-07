import { createHash } from 'node:crypto';

/**
 * The execution backend for sandboxed tenant code. The interface is **AOT-shaped**: code is treated as a
 * **content-addressed compiled module** (`compile` → a digest; `instantiate` → a runnable instance), even
 * though the first backend ([`QuickJsComputeEngine`](./quickjs-engine.ts)) interprets the source rather
 * than ahead-of-time compiling it to WebAssembly. A production AOT backend (extism/wasmtime,
 * [ADR 0010](../../../docs/decisions/0010-wasm-sandbox-compute-step.md)) drops in behind this same port —
 * yielding dev-mode = interpreter, prod-mode = AOT
 * ([ADR 0014](../../../docs/decisions/0014-compute-engine-interface.md)).
 *
 * The security core ([ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md)): a backend
 * grants **no ambient authority** — the sandbox sees only its typed `input`, never the network,
 * filesystem, process environment, clock, randomness, secrets, connector credentials, or inbound tokens.
 * Execution is bounded and fails closed (timeout, memory cap, output-size cap).
 */
export interface ComputeEngine {
  readonly kind: 'interpreter' | 'aot';
  /** Content-address a source unit. An AOT backend emits a WASM module here; the interpreter just hashes. */
  compile(source: string): Promise<ComputeModule>;
  /** Resolve a compiled module to a runnable instance. */
  instantiate(module: ComputeModule): Promise<ComputeInstance>;
}

/**
 * A handle to a compiled code unit. Carries only the **digest** (content hash) — never the source — so a
 * runtime artifact that references it stays reviewable as data
 * ([ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md)). The digest must **not** enter
 * an operation's signature hash.
 */
export interface ComputeModule {
  readonly digest: string;
  readonly engine: 'interpreter' | 'aot';
}

/** A runnable instance of a compiled module. */
export interface ComputeInstance {
  /**
   * Run the module against `input` under the given resource limits; resolves with the JSON output.
   * `onTimings` is called exactly once when the invocation settles (success or failure) with the
   * queue-wait and execution durations, measured independently.
   */
  invoke(
    input: unknown,
    limits: ComputeLimits,
    host?: ComputeHost,
    onTimings?: (timings: ComputeTimings) => void,
  ): Promise<unknown>;
  /** Release any retained resources. */
  dispose(): void;
}

/**
 * Independent duration measurements for one sandboxed invocation. Queue wait (time spent waiting
 * for an execution slot) and execution are timed separately so burst head-of-line blocking is
 * observable rather than folded into one opaque duration.
 */
export interface ComputeTimings {
  readonly queueWaitMs: number;
  readonly executionMs: number;
}

/** Host capability available to sandboxed code when a compute operation declares outbound calls. */
export interface ComputeHost {
  callOperation(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Optional tenant app-log sink. When absent, sandbox `console` remains unavailable. */
  log?(entry: ComputeAppLogEntry): void | Promise<void>;
}

export type ComputeAppLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ComputeAppLogEntry {
  readonly level: ComputeAppLogLevel;
  readonly message: string;
  readonly truncated?: boolean;
}

/** Resource bounds for a single sandboxed execution. All bounds fail closed. */
export interface ComputeLimits {
  /**
   * Total wall-clock budget for the call, **including queue wait** for an execution slot. Queue
   * wait is deducted from the execution budget; a call whose budget expires before execution
   * starts fails fast with `queue_timeout` instead of running anyway.
   */
  readonly timeoutMs: number;
  /** Hard cap on the sandbox heap, in bytes. */
  readonly memoryBytes: number;
  /** Hard cap on the serialized output, in bytes. */
  readonly maxOutputBytes: number;
  /** Maximum number of host-mediated connector calls one sandbox invocation may make. */
  readonly maxHostCalls: number;
}

/**
 * Conservative defaults for pure (non-suspending, no-outbound) compute. Instruction-fuel metering is a
 * property of the future AOT/wasmtime backend; the interpreter bounds wall-clock + memory + output only.
 */
export const DEFAULT_LIMITS: ComputeLimits = {
  timeoutMs: 1_000,
  memoryBytes: 16 << 20, // 16 MiB
  maxOutputBytes: 256 << 10, // 256 KiB
  maxHostCalls: 16,
};

/** Reasons a sandboxed execution fails. The code is stable; the message never carries host state. */
export type ComputeErrorCode =
  | 'unknown_module'
  | 'timeout'
  | 'queue_timeout'
  | 'memory'
  | 'output_too_large'
  | 'host_call_denied'
  | 'host_call_failed'
  | 'invalid_output'
  | 'runtime_error';

/**
 * Raised when a sandboxed execution cannot complete. Carries a stable code and an optional path; the
 * sandbox holds no host secrets (deny-by-default), so a bounded sandbox-internal message is safe to relay,
 * but the host never injects its own values or source into it.
 */
export class ComputeError extends Error {
  readonly code: ComputeErrorCode;
  readonly path: string | undefined;

  constructor(code: ComputeErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ComputeError';
    this.code = code;
    this.path = path;
  }
}

/** Content-address a source string as `sha256:<hex>` — the module digest. */
export function digestSource(source: string): string {
  return `sha256:${createHash('sha256').update(source, 'utf8').digest('hex')}`;
}

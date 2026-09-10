import type {
  QuickJSAsyncContext,
  QuickJSAsyncWASMModule,
  QuickJSContext,
  QuickJSHandle,
  QuickJSWASMModule,
} from 'quickjs-emscripten';
import { shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { helperPrelude, installDeterministicHelpers } from './deterministic-helpers.js';
import {
  type ComputeAppLogEntry,
  type ComputeAppLogLevel,
  ComputeError,
  type ComputeLimits,
} from './engine.js';

/**
 * The sandbox-evaluation core shared by the pure and host-mediated execution paths. It runs inside
 * a pool worker thread (see `worker-entry.ts`) so tenant compute never blocks the service's main
 * event loop; the only capabilities it can reach are the two bridge callbacks below, both of which
 * marshal JSON strings — the no-ambient-authority contract of
 * [ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md) is unchanged by the
 * thread boundary.
 */

/**
 * The worker-side gateway to host-mediated capabilities. `callOperation` returns a serialized
 * {@link HostEnvelope}; `log`, when present, delivers a bounded console entry and resolves once the
 * sink has accepted it. Both are message-channel round trips to the main thread.
 */
export interface SandboxHostBridge {
  readonly execution?: { readonly id: string };
  readonly coordination?: {
    readonly acquired: boolean;
    readonly previous?: { readonly reference: string; readonly operationDigest: string };
  };
  control?(name: string, argsJson: string): Promise<string>;
  callOperation(name: string, argsJson: string): Promise<string>;
  log?(entry: ComputeAppLogEntry): Promise<void>;
}

export type HostEnvelope =
  | { readonly ok: true; readonly output: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly path?: string };
    };

/**
 * Normalize a host-call failure into a bounded error envelope. The code/path pass through only as
 * strings and the message is truncated, so backend internals never re-enter sandbox code.
 */
export function hostErrorEnvelope(error: unknown): HostEnvelope {
  const err = error as { code?: unknown; path?: unknown; message?: unknown };
  return {
    ok: false,
    error: {
      code: typeof err.code === 'string' ? err.code : 'host_call_failed',
      message:
        typeof err.message === 'string' && err.message !== ''
          ? err.message.slice(0, 256)
          : 'host call failed',
      ...(typeof err.path === 'string' ? { path: err.path } : {}),
    },
  };
}

/** Run a pure (no-host) invocation synchronously on a fresh, disposable QuickJS runtime. */
export function runPure(
  wasm: QuickJSWASMModule,
  source: string,
  input: unknown,
  limits: ComputeLimits,
): string {
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));

  const context = runtime.newContext();
  try {
    installDeterministicHelpers(context);
    const wrapper = buildWrapper(source, input);
    const result = context.evalCode(wrapper, 'module.js');

    if (result.error) {
      const described = describeError(context, result.error);
      result.error.dispose();
      throw classifyError(described);
    }

    const out = readResultString(context, result.value, limits.maxOutputBytes);
    result.value.dispose();
    return out;
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

/** Run a host-mediated invocation on a fresh asyncified context from the worker's shared module. */
export async function runHosted(
  wasm: QuickJSAsyncWASMModule,
  source: string,
  input: unknown,
  limits: ComputeLimits,
  bridge: SandboxHostBridge,
): Promise<string> {
  const context = wasm.newContext();
  const runtime = context.runtime;
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.timeoutMs));

  try {
    installDeterministicHelpers(context);
    installHostCall(context, bridge, limits);
    if (bridge.log !== undefined) installConsole(context, bridge);
    const result = await context.evalCodeAsync(
      buildWrapper(
        source,
        input,
        true,
        bridge.log !== undefined,
        bridge.execution,
        bridge.coordination,
      ),
      'module.js',
    );

    if (result.error) {
      const described = describeError(context, result.error);
      result.error.dispose();
      throw classifyError(described);
    }

    const pendingResult = context.resolvePromise(result.value);
    await drainPendingJobs(runtime, context);
    const resolved = await pendingResult;
    result.value.dispose();
    if (resolved.error) {
      const described = describeError(context, resolved.error);
      resolved.error.dispose();
      throw classifyError(described);
    }

    const out = readResultString(context, resolved.value, limits.maxOutputBytes);
    resolved.value.dispose();
    return out;
  } finally {
    // The module-created context owns its runtime: disposing the context frees the runtime and
    // every global, so no per-global cleanup or separate runtime.dispose() belongs here.
    context.dispose();
  }
}

async function drainPendingJobs(
  runtime: QuickJSAsyncContext['runtime'],
  context: QuickJSAsyncContext,
): Promise<void> {
  while (runtime.hasPendingJob()) {
    const jobs = await runtime.executePendingJobs();
    if (jobs.error) {
      const described = describeError(context, jobs.error);
      jobs.error.dispose();
      throw classifyError(described);
    }
  }
}

/**
 * Build the script run inside the sandbox. The handler source is wrapped as an expression, called
 * with the JSON-marshaled input, and its result re-serialized to a string. A prelude removes
 * nondeterministic globals so "deterministic by default" holds for the future resume/idempotency
 * model ([ADR 0004](../../../docs/decisions/0004-code-as-sandboxed-connector.md)).
 */
function buildWrapper(
  source: string,
  input: unknown,
  hostEnabled = false,
  consoleEnabled = false,
  execution?: { readonly id: string },
  coordination?: SandboxHostBridge['coordination'],
): string {
  const callOperationPrelude = hostEnabled
    ? `
var __control = function(name, args) {
  var result = JSON.parse(globalThis.__hostControl(name, JSON.stringify(args)));
  if (!result.ok) { var error = new Error(result.error.message); error.name = result.error.code; throw error; }
  return result.output;
};
var callOperation = function(name, args) {
  var __hostEnvelope = JSON.parse(globalThis.__hostCallOperation(String(name), JSON.stringify(args ?? {})));
  if (!__hostEnvelope.ok) {
    var __err = new Error(__hostEnvelope.error.message || "host call failed");
    __err.name = __hostEnvelope.error.code || "host_call_failed";
    __err.code = __hostEnvelope.error.code;
    __err.path = __hostEnvelope.error.path;
    throw __err;
  }
  return __hostEnvelope.output;
};
`
    : '';
  const handlerArgs = `${jsLiteral(input ?? null)}, Object.freeze({
    time: __timeHelpers, digest: __digestHelper,
    ${
      hostEnabled
        ? `callOperation: callOperation,
      reportOutcome: function(evidence) { return __control('reportOutcome', evidence); },
      resolveCoordination: function() { return __control('resolveCoordination', {}); },`
        : ''
    }
    ${coordination === undefined ? '' : `coordination: Object.freeze(${jsLiteral(coordination)}),`}
    ${execution === undefined ? '' : `execution: Object.freeze(${jsLiteral(execution)}),`}
  })`;
  const consolePrelude = consoleEnabled
    ? `
var console = Object.freeze({
  debug: function() { return globalThis.__hostLog("debug", JSON.stringify(Array.prototype.slice.call(arguments))); },
  info: function() { return globalThis.__hostLog("info", JSON.stringify(Array.prototype.slice.call(arguments))); },
  log: function() { return globalThis.__hostLog("info", JSON.stringify(Array.prototype.slice.call(arguments))); },
  warn: function() { return globalThis.__hostLog("warn", JSON.stringify(Array.prototype.slice.call(arguments))); },
  error: function() { return globalThis.__hostLog("error", JSON.stringify(Array.prototype.slice.call(arguments))); }
});
`
    : '';
  const bodyPrefix = `"use strict";
delete globalThis.Date;
delete globalThis.Intl;
delete Math.random;
${helperPrelude}
${callOperationPrelude}
${consolePrelude}
var __handler = (${source});
if (typeof __handler !== "function") { throw new TypeError("compute module must evaluate to a function"); }`;
  if (hostEnabled) {
    return `${bodyPrefix}
Promise.resolve(__handler(${handlerArgs})).then(function(__value) {
  var __out = JSON.stringify(__value);
  return (typeof __out === "string") ? __out : "null";
});`;
  }
  return `${bodyPrefix}
var __out = JSON.stringify(__handler(${handlerArgs}));
(typeof __out === "string") ? __out : "null";`;
}

function installHostCall(
  context: QuickJSAsyncContext,
  bridge: SandboxHostBridge,
  limits: ComputeLimits,
): void {
  let calls = 0;
  let controls = 0;
  const control = context.newAsyncifiedFunction('__hostControl', async (name, args) => {
    if (++controls > 4 || !bridge.control)
      return context.newString(
        JSON.stringify({
          ok: false,
          error: { code: 'host_call_denied', message: 'host control budget exceeded' },
        }),
      );
    const argsJson = context.getString(args);
    if (argsJson.length > 2048)
      return context.newString(
        JSON.stringify({
          ok: false,
          error: { code: 'host_call_denied', message: 'host control input exceeds bound' },
        }),
      );
    return context.newString(await bridge.control(context.getString(name), argsJson));
  });
  context.setProp(context.global, '__hostControl', control);
  control.dispose();
  const fn = context.newAsyncifiedFunction(
    '__hostCallOperation',
    async (nameHandle, argsJsonHandle) => {
      const envelopeJson = await (async (): Promise<string> => {
        if (calls >= limits.maxHostCalls) {
          return JSON.stringify({
            ok: false,
            error: { code: 'host_call_denied', message: 'host call budget exceeded' },
          } satisfies HostEnvelope);
        }
        calls += 1;

        const name = context.getString(nameHandle);
        const argsJson = context.getString(argsJsonHandle);
        let args: unknown;
        try {
          args = JSON.parse(argsJson);
        } catch {
          return JSON.stringify({
            ok: false,
            error: { code: 'host_call_denied', message: 'host call arguments must be JSON' },
          } satisfies HostEnvelope);
        }
        if (args === null || typeof args !== 'object' || Array.isArray(args)) {
          return JSON.stringify({
            ok: false,
            error: { code: 'host_call_denied', message: 'host call arguments must be an object' },
          } satisfies HostEnvelope);
        }

        try {
          return await bridge.callOperation(name, argsJson);
        } catch {
          return JSON.stringify({
            ok: false,
            error: { code: 'host_call_failed', message: 'host call failed' },
          } satisfies HostEnvelope);
        }
      })();

      return context.newString(envelopeJson);
    },
  );
  context.setProp(context.global, '__hostCallOperation', fn);
  fn.dispose();
}

function installConsole(context: QuickJSAsyncContext, bridge: SandboxHostBridge): void {
  const fn = context.newAsyncifiedFunction('__hostLog', async (levelHandle, argsJsonHandle) => {
    const level = normalizeLogLevel(context.getString(levelHandle));
    const args = parseLogArgs(context.getString(argsJsonHandle));
    const entry = formatLogEntry(level, args);
    await bridge.log?.(entry);
    return context.undefined;
  });
  context.setProp(context.global, '__hostLog', fn);
  fn.dispose();
}

function normalizeLogLevel(level: string): ComputeAppLogLevel {
  return level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
}

function parseLogArgs(json: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const MAX_LOG_MESSAGE_CHARS = 1024;

function formatLogEntry(level: ComputeAppLogLevel, args: readonly unknown[]): ComputeAppLogEntry {
  const message = args.map(formatLogArg).join(' ');
  if (message.length <= MAX_LOG_MESSAGE_CHARS) return { level, message };
  return { level, message: message.slice(0, MAX_LOG_MESSAGE_CHARS), truncated: true };
}

function formatLogArg(value: unknown): string {
  if (value === null || value === undefined) return '';
  const type = typeof value;
  if (type === 'string') return value as string;
  if (type === 'number' || type === 'boolean') return String(value);
  return '[unloggable]';
}

/** Read the string completion value, enforcing the output-size cap and JSON validity. */
function readResultString(
  context: QuickJSContext,
  value: QuickJSHandle,
  maxOutputBytes: number,
): string {
  const text = context.getString(value);
  if (Buffer.byteLength(text, 'utf8') > maxOutputBytes) {
    throw new ComputeError('output_too_large', 'compute output exceeds the size limit');
  }
  try {
    JSON.parse(text);
  } catch {
    throw new ComputeError('invalid_output', 'compute output is not valid JSON');
  }
  return text;
}

/** Extract a bounded `{ name, message }` from a sandbox error handle without leaking host state. */
function describeError(
  context: QuickJSContext,
  handle: QuickJSHandle,
): { name: string; message: string } {
  let dumped: unknown;
  try {
    dumped = context.dump(handle);
  } catch {
    return { name: 'Error', message: 'sandbox error' };
  }
  if (dumped !== null && typeof dumped === 'object') {
    const o = dumped as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : 'Error';
    const message = typeof o.message === 'string' ? o.message : '';
    return { name, message };
  }
  return { name: 'Error', message: String(dumped) };
}

/** Map a sandbox error to a stable {@link ComputeError} code; truncate the relayed message. */
function classifyError(described: { name: string; message: string }): ComputeError {
  const lower = described.message.toLowerCase();
  if (lower.includes('interrupted')) {
    return new ComputeError('timeout', 'compute exceeded its time budget');
  }
  if (lower.includes('out of memory')) {
    return new ComputeError('memory', 'compute exceeded its memory limit');
  }
  if (described.name === 'host_call_denied' || described.name === 'host_call_failed') {
    return new ComputeError(described.name, described.message.slice(0, 256) || 'host call failed');
  }
  const detail = `${described.name}: ${described.message}`.slice(0, 256);
  return new ComputeError('runtime_error', detail);
}

/** Embed a JSON-safe value as a JavaScript literal, escaping the line/paragraph separators. */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/[\u2028\u2029]/g, (c) =>
    c === '\u2028' ? '\\u2028' : '\\u2029',
  );
}

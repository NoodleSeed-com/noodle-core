import type { ComputeAppLogEntry, ComputeErrorCode, ComputeLimits } from './engine.js';

/**
 * The message protocol between the compute worker pool (main thread) and a sandbox worker.
 * Everything that crosses the boundary is JSON-safe data — sources, marshaled inputs/outputs, and
 * host-call envelopes as JSON strings — never object references, callbacks, or host state, so the
 * sandbox's no-ambient-authority contract is unchanged by the thread boundary.
 */

/** Start one sandboxed invocation. `limits.timeoutMs` is the remaining execution budget. */
export interface RunMessage {
  readonly t: 'run';
  readonly id: number;
  readonly source: string;
  /** The invocation input, JSON-serialized on the main thread — never a live object reference. */
  readonly inputJson: string;
  readonly limits: ComputeLimits;
  readonly hostEnabled: boolean;
  readonly consoleEnabled: boolean;
}

/** Deliver the host-call envelope (JSON `HostEnvelope`) for an outstanding `host_call`. */
interface HostResultMessage {
  readonly t: 'host_result';
  readonly callId: number;
  readonly envelopeJson: string;
}

/** Acknowledge a `log` message so the sandbox's `console` call can complete. */
interface LogDoneMessage {
  readonly t: 'log_done';
  readonly callId: number;
}

export type MainToWorkerMessage = RunMessage | HostResultMessage | LogDoneMessage;

/** A sandbox `callOperation` that must be mediated by the runtime host on the main thread. */
interface HostCallMessage {
  readonly t: 'host_call';
  readonly id: number;
  readonly callId: number;
  readonly name: string;
  readonly argsJson: string;
}

/** A bounded, already-formatted sandbox console entry for the host log sink. */
interface LogMessage {
  readonly t: 'log';
  readonly id: number;
  readonly callId: number;
  readonly entry: ComputeAppLogEntry;
}

/** The invocation settled: the serialized JSON output, or a stable compute error. */
export interface ResultMessage {
  readonly t: 'result';
  readonly id: number;
  readonly outcome:
    | { readonly ok: true; readonly outputJson: string }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: ComputeErrorCode;
          readonly message: string;
          readonly path?: string;
        };
      };
}

export type WorkerToMainMessage = HostCallMessage | LogMessage | ResultMessage;

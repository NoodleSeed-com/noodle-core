import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import {
  type ComputeAppLogEntry,
  ComputeError,
  type ComputeLimits,
  type ComputeTimings,
} from './engine.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './worker-messages.js';

/**
 * A bounded pool of sandbox worker threads with an explicit admission queue. This is the seam that
 * prevents head-of-line blocking between independent compute invocations (issue #1307): each
 * invocation runs off the main thread, at most `maxWorkers` run at once, queue wait counts against
 * the call's total `timeoutMs` budget (expiring queued calls fail fast with `queue_timeout`), and
 * queue-wait and execution durations are measured independently. A worker that overruns its
 * deadline without yielding — e.g. suspended in a hanging host call — is terminated and replaced,
 * so the budget binds even when the in-sandbox interrupt cannot fire.
 */

export interface ComputeWorkerPoolOptions {
  /** Maximum concurrently executing sandbox invocations (worker threads). */
  readonly maxWorkers?: number;
  /**
   * Extra wall-clock allowance past the execution deadline before the worker is forcibly
   * terminated. The in-sandbox interrupt normally fires first and yields a clean error; the
   * terminate backstop bounds invocations the interrupt cannot reach.
   */
  readonly terminateGraceMs?: number;
}

/**
 * The main-thread side of a sandbox host: `callOperation` receives the sandbox-local operation name
 * and its JSON-encoded arguments and resolves with a serialized `HostEnvelope`; `log` accepts a
 * bounded console entry. Only JSON strings and flat entries cross the thread boundary.
 */
export interface PoolHostBridge {
  readonly execution?: { readonly id: string };
  readonly coordination?: {
    readonly acquired: boolean;
    readonly previous?: { readonly reference: string; readonly operationDigest: string };
  };
  control?(name: string, argsJson: string): Promise<string>;
  callOperation(name: string, argsJson: string): Promise<string>;
  log?(entry: ComputeAppLogEntry): Promise<void>;
}

export interface PoolJob {
  readonly source: string;
  /** The invocation input as a JSON string; the caller serializes before submission. */
  readonly inputJson: string;
  readonly limits: ComputeLimits;
  readonly host?: PoolHostBridge;
  readonly consoleEnabled: boolean;
  readonly onTimings?: (timings: ComputeTimings) => void;
}

interface ActiveRun {
  readonly id: number;
  readonly job: PoolJob;
  readonly queueWaitMs: number;
  readonly startedAt: number;
  readonly backstop: NodeJS.Timeout;
  settled: boolean;
  readonly resolve: (output: unknown) => void;
  readonly reject: (error: ComputeError) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  runs: number;
  active: ActiveRun | null;
  dropped: boolean;
}

interface QueueEntry {
  readonly job: PoolJob;
  readonly enqueuedAt: number;
  readonly expiry: NodeJS.Timeout;
  readonly resolve: (output: unknown) => void;
  readonly reject: (error: ComputeError) => void;
}

const DEFAULT_TERMINATE_GRACE_MS = 500;
/** Recycle a worker after this many runs to bound WASM heap growth in the shared modules. */
const WORKER_RECYCLE_AFTER_RUNS = 128;

function defaultMaxWorkers(): number {
  return Math.min(4, Math.max(2, availableParallelism() - 1));
}

export class ComputeWorkerPool {
  readonly #maxWorkers: number;
  readonly #terminateGraceMs: number;
  readonly #slots: WorkerSlot[] = [];
  readonly #queue: QueueEntry[] = [];
  #nextRunId = 0;
  #closed = false;

  constructor(options: ComputeWorkerPoolOptions = {}) {
    this.#maxWorkers = Math.max(1, options.maxWorkers ?? defaultMaxWorkers());
    this.#terminateGraceMs = Math.max(0, options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS);
  }

  /** Run one sandboxed invocation; resolves with the parsed JSON output. */
  execute(job: PoolJob): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closed) {
        reject(new ComputeError('runtime_error', 'compute engine closed'));
        return;
      }
      const enqueuedAt = Date.now();
      const idle = this.#slots.find((slot) => slot.active === null && !slot.dropped);
      if (idle !== undefined) {
        this.#dispatch(idle, job, enqueuedAt, resolve, reject);
        return;
      }
      if (this.#slots.length < this.#maxWorkers) {
        this.#dispatch(this.#spawn(), job, enqueuedAt, resolve, reject);
        return;
      }
      const entry: QueueEntry = {
        job,
        enqueuedAt,
        expiry: setTimeout(() => this.#expireQueued(entry), job.limits.timeoutMs),
        resolve,
        reject,
      };
      this.#queue.push(entry);
    });
  }

  /** Reject queued and in-flight work and terminate every worker. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#queue.splice(0)) {
      clearTimeout(entry.expiry);
      reportTimings(entry.job, Date.now() - entry.enqueuedAt, 0);
      entry.reject(new ComputeError('runtime_error', 'compute engine closed'));
    }
    const slots = this.#slots.splice(0);
    for (const slot of slots) {
      slot.dropped = true;
      const active = slot.active;
      if (active !== null && !active.settled) {
        active.settled = true;
        clearTimeout(active.backstop);
        reportTimings(active.job, active.queueWaitMs, Date.now() - active.startedAt);
        active.reject(new ComputeError('runtime_error', 'compute engine closed'));
      }
    }
    await Promise.all(slots.map((slot) => slot.worker.terminate().catch(() => undefined)));
  }

  #spawn(): WorkerSlot {
    const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
      workerData: { noodleComputeWorker: true },
    });
    const slot: WorkerSlot = { worker, runs: 0, active: null, dropped: false };
    worker.on('message', (message: WorkerToMainMessage) => this.#onMessage(slot, message));
    worker.on('error', () => this.#onWorkerLost(slot));
    worker.on('exit', () => this.#onWorkerLost(slot));
    // Registering a message listener references the Worker again, so unref must happen last. This
    // lets one-shot CLI processes exit after their compute result without closing the shared pool.
    worker.unref();
    this.#slots.push(slot);
    return slot;
  }

  #dispatch(
    slot: WorkerSlot,
    job: PoolJob,
    enqueuedAt: number,
    resolve: (output: unknown) => void,
    reject: (error: ComputeError) => void,
  ): void {
    const startedAt = Date.now();
    const queueWaitMs = Math.max(0, startedAt - enqueuedAt);
    const remainingMs = Math.max(1, job.limits.timeoutMs - queueWaitMs);
    const id = this.#nextRunId;
    this.#nextRunId += 1;
    const active: ActiveRun = {
      id,
      job,
      queueWaitMs,
      startedAt,
      backstop: setTimeout(
        () => this.#onDeadline(slot, active),
        remainingMs + this.#terminateGraceMs,
      ),
      settled: false,
      resolve,
      reject,
    };
    slot.active = active;
    const message: MainToWorkerMessage = {
      t: 'run',
      id,
      source: job.source,
      inputJson: job.inputJson,
      limits: { ...job.limits, timeoutMs: remainingMs },
      hostEnabled: job.host !== undefined,
      consoleEnabled: job.consoleEnabled,
      ...(job.host?.execution === undefined ? {} : { execution: job.host.execution }),
      ...(job.host?.coordination === undefined ? {} : { coordination: job.host.coordination }),
    };
    slot.worker.postMessage(message);
  }

  #onMessage(slot: WorkerSlot, message: WorkerToMainMessage): void {
    const active = slot.active;
    if (active === null || active.settled || active.id !== message.id) return;

    if (message.t === 'result') {
      active.settled = true;
      clearTimeout(active.backstop);
      slot.active = null;
      reportTimings(active.job, active.queueWaitMs, Date.now() - active.startedAt);
      if (message.outcome.ok) {
        active.resolve(JSON.parse(message.outcome.outputJson));
      } else {
        const { code, message: text, path } = message.outcome.error;
        active.reject(new ComputeError(code, text, path));
      }
      this.#release(slot);
      return;
    }

    if (message.t === 'host_call' || message.t === 'host_control') {
      const host = active.job.host;
      const respond = (envelopeJson: string): void => {
        if (slot.active === active && !active.settled && !slot.dropped) {
          const reply: MainToWorkerMessage = {
            t: 'host_result',
            callId: message.callId,
            envelopeJson,
          };
          slot.worker.postMessage(reply);
        }
      };
      if (host === undefined) {
        respond(
          JSON.stringify({
            ok: false,
            error: { code: 'host_call_failed', message: 'host call unavailable' },
          }),
        );
        return;
      }
      const invoke = message.t === 'host_control' ? host.control : host.callOperation;
      if (!invoke) {
        respond(
          JSON.stringify({
            ok: false,
            error: { code: 'host_call_denied', message: 'host control unavailable' },
          }),
        );
        return;
      }
      invoke(message.name, message.argsJson)
        .then(respond)
        .catch(() =>
          respond(
            JSON.stringify({
              ok: false,
              error: { code: 'host_call_failed', message: 'host call failed' },
            }),
          ),
        );
      return;
    }

    if (message.t !== 'log') return;
    // 'log': deliver to the sink (fire-and-forget failures) and always release the sandbox.
    const ack = (): void => {
      if (slot.active === active && !active.settled && !slot.dropped) {
        const reply: MainToWorkerMessage = { t: 'log_done', callId: message.callId };
        slot.worker.postMessage(reply);
      }
    };
    const sink = active.job.host?.log;
    if (sink === undefined) {
      ack();
      return;
    }
    Promise.resolve()
      .then(() => sink(message.entry))
      .catch(() => undefined)
      .then(ack);
  }

  /** The queued call's total budget expired before a worker freed: fail fast, stably classified. */
  #expireQueued(entry: QueueEntry): void {
    const index = this.#queue.indexOf(entry);
    if (index === -1) return;
    this.#queue.splice(index, 1);
    reportTimings(entry.job, Date.now() - entry.enqueuedAt, 0);
    entry.reject(
      new ComputeError('queue_timeout', 'compute queue wait exhausted the call time budget'),
    );
  }

  /** The execution deadline (plus grace) passed without a result: terminate and replace the worker. */
  #onDeadline(slot: WorkerSlot, active: ActiveRun): void {
    if (active.settled || slot.active !== active) return;
    active.settled = true;
    slot.active = null;
    reportTimings(active.job, active.queueWaitMs, Date.now() - active.startedAt);
    active.reject(new ComputeError('timeout', 'compute exceeded its time budget'));
    this.#drop(slot);
    this.#pumpQueue();
  }

  #onWorkerLost(slot: WorkerSlot): void {
    if (slot.dropped) return;
    const active = slot.active;
    if (active !== null && !active.settled) {
      active.settled = true;
      clearTimeout(active.backstop);
      slot.active = null;
      reportTimings(active.job, active.queueWaitMs, Date.now() - active.startedAt);
      active.reject(new ComputeError('runtime_error', 'compute worker exited unexpectedly'));
    }
    this.#drop(slot);
    this.#pumpQueue();
  }

  #release(slot: WorkerSlot): void {
    slot.runs += 1;
    if (slot.runs >= WORKER_RECYCLE_AFTER_RUNS) {
      this.#drop(slot);
    }
    this.#pumpQueue();
  }

  #drop(slot: WorkerSlot): void {
    if (slot.dropped) return;
    slot.dropped = true;
    const index = this.#slots.indexOf(slot);
    if (index !== -1) this.#slots.splice(index, 1);
    void slot.worker.terminate().catch(() => undefined);
  }

  #pumpQueue(): void {
    while (this.#queue.length > 0) {
      const slot =
        this.#slots.find((candidate) => candidate.active === null && !candidate.dropped) ??
        (this.#slots.length < this.#maxWorkers ? this.#spawn() : undefined);
      if (slot === undefined) return;
      const entry = this.#queue.shift() as QueueEntry;
      clearTimeout(entry.expiry);
      // A slot can free in the same tick the expiry timer is due; keep the classification stable
      // by expiring an already-exhausted budget here instead of dispatching with the 1ms floor.
      if (Date.now() - entry.enqueuedAt >= entry.job.limits.timeoutMs) {
        reportTimings(entry.job, Date.now() - entry.enqueuedAt, 0);
        entry.reject(
          new ComputeError('queue_timeout', 'compute queue wait exhausted the call time budget'),
        );
        continue;
      }
      this.#dispatch(slot, entry.job, entry.enqueuedAt, entry.resolve, entry.reject);
    }
  }
}

function reportTimings(job: PoolJob, queueWaitMs: number, executionMs: number): void {
  try {
    job.onTimings?.({ queueWaitMs, executionMs });
  } catch {
    // A telemetry callback must never break the invocation path.
  }
}

let shared: ComputeWorkerPool | undefined;

/**
 * The process-wide default pool. Engines share it so many per-deployment engines on one service
 * instance stay within one bounded worker set; a private pool exists only when an engine is
 * constructed with explicit options (tests, dedicated capacity).
 */
export function sharedComputeWorkerPool(): ComputeWorkerPool {
  shared ??= new ComputeWorkerPool();
  return shared;
}

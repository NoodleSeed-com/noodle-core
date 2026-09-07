import type { RequestEventInput, RequestEventSink } from '@noodle-borg/module';

const DEFAULT_CAP = 1024;

/**
 * Bounded async write-behind buffer between the transport's synchronous capture hook and a durable
 * {@link RequestEventSink} (ADR 0121). `capture()` is enqueue-only — it never awaits a store write, so
 * the MCP response path pays no durable-write latency. Under backpressure the **newest** events drop
 * (`droppedTotal` counts them); store failures are swallowed and counted (`failedTotal`); `close()`
 * drains what is queued. Analytics is strictly best-effort by contract.
 */
export class RequestEventBuffer {
  readonly #sink: RequestEventSink;
  readonly #cap: number;
  readonly #queue: RequestEventInput[] = [];
  #draining: Promise<void> = Promise.resolve();
  #inFlight = false;
  #closed = false;
  #dropped = 0;
  #failed = 0;

  constructor(sink: RequestEventSink, options: { cap?: number } = {}) {
    this.#sink = sink;
    this.#cap = options.cap ?? DEFAULT_CAP;
  }

  /** Enqueue one event; drops (and counts) when closed or the queue is full. Never throws. */
  capture(event: RequestEventInput): void {
    if (this.#closed || this.#queue.length >= this.#cap) {
      this.#dropped += 1;
      return;
    }
    this.#queue.push(event);
    if (!this.#inFlight) {
      this.#inFlight = true;
      this.#draining = this.#drain();
    }
  }

  async #drain(): Promise<void> {
    while (this.#queue.length > 0) {
      const event = this.#queue.shift();
      if (event === undefined) break;
      try {
        await this.#sink.emit(event);
      } catch {
        this.#failed += 1; // best-effort: a down store must not spill into request handling
      }
    }
    this.#inFlight = false;
  }

  /** Events currently queued and not yet durably written. */
  get depth(): number {
    return this.#queue.length;
  }

  /** Events dropped because the buffer was full or closed. */
  get droppedTotal(): number {
    return this.#dropped;
  }

  /** Events whose durable write failed (swallowed). */
  get failedTotal(): number {
    return this.#failed;
  }

  /** Stop accepting events and wait for the queued ones to flush. */
  async close(): Promise<void> {
    this.#closed = true;
    await this.#draining;
  }
}

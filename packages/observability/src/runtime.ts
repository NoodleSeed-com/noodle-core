import type { IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import { IntentEventBuffer, PostgresIntentEventStore } from './intent-capture.js';
import { RequestEventBuffer } from './request-event-buffer.js';
import { PostgresRequestEventStore } from './request-events-postgres.js';

export interface TelemetryRuntime {
  readonly requestEventBuffer: RequestEventBuffer;
  readonly intentEventBuffer: IntentEventBuffer;
  readonly retentionTimer?: NodeJS.Timeout;
  readonly intentRetentionTimer?: NodeJS.Timeout;
  readonly heartbeatTimer?: NodeJS.Timeout;
  /** Stop every runtime-owned timer and drain both buffers; the runtime owns its own lifecycle. */
  dispose(): Promise<void>;
}

/** Cumulative pipeline-health counters for one telemetry stream (drops/failures never reset). */
export interface TelemetryStreamHealth {
  readonly depth: number;
  readonly dropped: number;
  readonly failed: number;
}

/** One heartbeat snapshot of the analytics pipeline's own health (#1309): silently dropped or
 * failed writes were previously invisible, which turns an empty store into an unanswerable incident. */
export interface TelemetryHealth {
  readonly requestEvents: TelemetryStreamHealth;
  readonly intentEvents: TelemetryStreamHealth;
}

/** Minimal structured-logger slice for the built-in heartbeat line (structurally the host logger). */
export interface TelemetryHealthLogger {
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface TelemetryRuntimeOptions {
  /** Receives a periodic health snapshot; the caller decides how to act on it. */
  readonly onHeartbeat?: (health: TelemetryHealth) => void;
  /** Logs one flat scalar `telemetry.health` line per beat (log-based alerting watches these). */
  readonly heartbeatLogger?: TelemetryHealthLogger;
  /** Heartbeat cadence; defaults to 5 minutes. */
  readonly heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function createTelemetryRuntime(
  requestEvents: RequestEventStore,
  intentEvents: IntentEventStore,
  requestRetentionDays: number,
  options: TelemetryRuntimeOptions = {},
): TelemetryRuntime {
  const requestEventBuffer = new RequestEventBuffer(requestEvents);
  const intentEventBuffer = new IntentEventBuffer(intentEvents);
  const retentionTimer =
    requestEvents instanceof PostgresRequestEventStore
      ? startPruner(requestRetentionDays, (cutoff) => requestEvents.prune(cutoff))
      : undefined;
  const intentRetentionTimer =
    intentEvents instanceof PostgresIntentEventStore
      ? startPruner(14, (cutoff) => intentEvents.prune(cutoff))
      : undefined;
  const heartbeatTimer =
    options.onHeartbeat === undefined && options.heartbeatLogger === undefined
      ? undefined
      : startHeartbeat(
          requestEventBuffer,
          intentEventBuffer,
          options,
          options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        );
  const timers = [retentionTimer, intentRetentionTimer, heartbeatTimer];
  return {
    requestEventBuffer,
    intentEventBuffer,
    ...(retentionTimer === undefined ? {} : { retentionTimer }),
    ...(intentRetentionTimer === undefined ? {} : { intentRetentionTimer }),
    ...(heartbeatTimer === undefined ? {} : { heartbeatTimer }),
    async dispose(): Promise<void> {
      for (const timer of timers) if (timer !== undefined) clearInterval(timer);
      const failures: unknown[] = [];
      for (const drain of [requestEventBuffer, intentEventBuffer]) {
        try {
          await drain.close();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'telemetry runtime dispose failed');
      }
    },
  };
}

/** Snapshot both buffers' health counters; shared by the timer and direct callers/tests. */
export function telemetryHealthSnapshot(
  requestEventBuffer: RequestEventBuffer,
  intentEventBuffer: IntentEventBuffer,
): TelemetryHealth {
  return {
    requestEvents: {
      depth: requestEventBuffer.depth,
      dropped: requestEventBuffer.droppedTotal,
      failed: requestEventBuffer.failedTotal,
    },
    intentEvents: {
      depth: intentEventBuffer.depth,
      dropped: intentEventBuffer.droppedTotal,
      failed: intentEventBuffer.failedTotal,
    },
  };
}

function startHeartbeat(
  requestEventBuffer: RequestEventBuffer,
  intentEventBuffer: IntentEventBuffer,
  options: Pick<TelemetryRuntimeOptions, 'onHeartbeat' | 'heartbeatLogger'>,
  intervalMs: number,
): NodeJS.Timeout {
  const beat = (): void => {
    try {
      const health = telemetryHealthSnapshot(requestEventBuffer, intentEventBuffer);
      options.onHeartbeat?.(health);
      options.heartbeatLogger?.info('telemetry.health', {
        requestEventsDepth: health.requestEvents.depth,
        requestEventsDropped: health.requestEvents.dropped,
        requestEventsFailed: health.requestEvents.failed,
        intentEventsDepth: health.intentEvents.depth,
        intentEventsDropped: health.intentEvents.dropped,
        intentEventsFailed: health.intentEvents.failed,
      });
    } catch {
      // Health reporting must never disturb the pipeline it watches.
    }
  };
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return timer;
}

function startPruner(days: number, prune: (cutoff: Date) => Promise<number>): NodeJS.Timeout {
  const run = (): void => {
    void prune(new Date(Date.now() - days * 24 * 60 * 60 * 1000)).catch(() => undefined);
  };
  run();
  const timer = setInterval(run, 6 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

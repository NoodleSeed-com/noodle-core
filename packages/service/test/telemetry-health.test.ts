import type { IntentEventInput, RequestEventInput } from '@noodle-borg/module';
import {
  createTelemetryRuntime,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  RequestEventBuffer,
  type TelemetryHealth,
  telemetryHealthSnapshot,
} from '@noodle-borg/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Analytics pipeline self-health (#1309): dropped or failed telemetry writes were previously
 * counted but never surfaced anywhere, so an empty analytics store during an incident could not be
 * told apart from a silently failing pipeline.
 */

function requestEvent(requestId: string): RequestEventInput {
  return {
    org: 'acme',
    requestId,
    sessionSource: 'none',
    subjectKind: 'anonymous',
    method: 'tools/call',
    kind: 'usage',
    outcome: 'ok',
    durationMs: 1,
  };
}

const intentEvent: IntentEventInput = {
  org: 'acme',
  app: 'support',
  env: 'prod',
  requestId: 'r-1',
  toolName: 'get_order',
  outcome: 'ok',
  category: 'support',
  match: 'direct',
  goal: 'g',
  source: 'tool_schema',
};

describe('telemetry pipeline health', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports buffer depth, drops, and failures in the snapshot', async () => {
    let rejectInFlight: ((error: Error) => void) | undefined;
    const failing = {
      emit: (): Promise<void> =>
        new Promise<void>((_resolve, reject) => {
          rejectInFlight = reject;
        }),
      list: (): Promise<never[]> => Promise.resolve([]),
    };
    const buffer = new RequestEventBuffer(failing, { cap: 1 });
    buffer.capture(requestEvent('r-1')); // shifted straight into the in-flight write
    buffer.capture(requestEvent('r-2')); // queued (depth 1 = cap)
    expect(buffer.depth).toBe(1);
    buffer.capture(requestEvent('r-3')); // over cap → dropped
    expect(buffer.droppedTotal).toBe(1);

    rejectInFlight?.(new Error('store down'));
    await vi.runAllTicks();
    rejectInFlight?.(new Error('store down'));
    await buffer.close();

    expect(buffer.failedTotal).toBeGreaterThanOrEqual(1);
    expect(buffer.depth).toBe(0);
  });

  it('emits periodic heartbeats with both streams when a listener is configured', async () => {
    const beats: TelemetryHealth[] = [];
    const runtime = createTelemetryRuntime(
      new InMemoryRequestEventStore(),
      new InMemoryIntentEventStore(),
      30,
      { onHeartbeat: (health) => beats.push(health), heartbeatIntervalMs: 1000 },
    );
    expect(runtime.heartbeatTimer).toBeDefined();

    runtime.requestEventBuffer.capture(requestEvent('r-1'));
    runtime.intentEventBuffer.capture(intentEvent);
    await vi.advanceTimersByTimeAsync(3000);

    expect(beats.length).toBe(3);
    expect(beats[0]).toEqual({
      requestEvents: { depth: expect.any(Number), dropped: 0, failed: 0 },
      intentEvents: { depth: expect.any(Number), dropped: 0, failed: 0 },
    });
    await runtime.dispose();
  });

  it('logs one flat scalar telemetry.health line per beat through a heartbeat logger', async () => {
    const lines: [string, Readonly<Record<string, unknown>> | undefined][] = [];
    const runtime = createTelemetryRuntime(
      new InMemoryRequestEventStore(),
      new InMemoryIntentEventStore(),
      30,
      {
        heartbeatLogger: { info: (event, fields) => lines.push([event, fields]) },
        heartbeatIntervalMs: 1000,
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(lines).toEqual([
      [
        'telemetry.health',
        {
          requestEventsDepth: 0,
          requestEventsDropped: 0,
          requestEventsFailed: 0,
          intentEventsDepth: 0,
          intentEventsDropped: 0,
          intentEventsFailed: 0,
        },
      ],
    ]);
    await runtime.dispose();
  });

  it('starts no heartbeat timer without a listener, and a throwing listener never breaks anything', async () => {
    const silent = createTelemetryRuntime(
      new InMemoryRequestEventStore(),
      new InMemoryIntentEventStore(),
      30,
    );
    expect(silent.heartbeatTimer).toBeUndefined();
    await silent.dispose();

    const noisy = createTelemetryRuntime(
      new InMemoryRequestEventStore(),
      new InMemoryIntentEventStore(),
      30,
      {
        onHeartbeat: () => {
          throw new Error('listener bug');
        },
        heartbeatIntervalMs: 1000,
      },
    );
    await vi.advanceTimersByTimeAsync(2500); // would reject the test run if the throw escaped
    noisy.requestEventBuffer.capture(requestEvent('r-9'));
    await noisy.dispose();
  });

  it('snapshots cumulative counters directly', async () => {
    const store = new InMemoryRequestEventStore();
    const requestBuffer = new RequestEventBuffer(store);
    const intentStore = new InMemoryIntentEventStore();
    const runtime = createTelemetryRuntime(store, intentStore, 30);
    const health = telemetryHealthSnapshot(requestBuffer, runtime.intentEventBuffer);
    expect(health).toEqual({
      requestEvents: { depth: 0, dropped: 0, failed: 0 },
      intentEvents: { depth: 0, dropped: 0, failed: 0 },
    });
    await runtime.dispose();
  });
});

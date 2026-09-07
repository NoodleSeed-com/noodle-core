import type { RequestEventInput, RequestEventSink } from '@noodle-borg/module';
import { InMemoryRequestEventStore, RequestEventBuffer } from '@noodle-borg/observability';
import { describe, expect, it } from 'vitest';

function base(requestId: string): RequestEventInput {
  return {
    org: 'acme',
    app: 'support',
    env: 'prod',
    requestId,
    sessionSource: 'none',
    subjectKind: 'anonymous',
    method: 'tools/call',
    kind: 'usage',
    outcome: 'ok',
    durationMs: 1,
  };
}

/** A sink whose writes only settle when the test releases them. */
function gatedSink(): RequestEventSink & { release(): void; written: RequestEventInput[] } {
  const written: RequestEventInput[] = [];
  let releases: (() => void)[] = [];
  return {
    written,
    emit(event: RequestEventInput): Promise<void> {
      written.push(event);
      return new Promise((resolve) => releases.push(resolve));
    },
    release(): void {
      const pending = releases;
      releases = [];
      for (const resolve of pending) resolve();
    },
  };
}

describe('RequestEventBuffer', () => {
  it('capture() is synchronous and events reach the store after drain', async () => {
    const store = new InMemoryRequestEventStore();
    const buffer = new RequestEventBuffer(store);
    buffer.capture(base('a'));
    buffer.capture(base('b'));
    await buffer.close();

    const events = await store.list({ org: 'acme' });
    expect(events.map((e) => e.requestId)).toEqual(['b', 'a']);
  });

  it('drops newest beyond the cap and counts drops', async () => {
    const sink = gatedSink();
    const buffer = new RequestEventBuffer(sink, { cap: 2 });
    // First capture starts an in-flight write; two more fill the queue; the rest drop.
    for (let i = 0; i < 5; i++) buffer.capture(base(`r${i}`));
    expect(buffer.droppedTotal).toBe(2);

    // Release writes until the three accepted events have all reached the sink.
    while (sink.written.length < 3) {
      sink.release();
      await new Promise((resolve) => setImmediate(resolve));
    }
    sink.release();
    await buffer.close();
    expect(sink.written.map((e) => e.requestId)).toEqual(['r0', 'r1', 'r2']);
  });

  it('a failing store write is swallowed and counted, later events still flush', async () => {
    let calls = 0;
    const written: string[] = [];
    const flaky: RequestEventSink = {
      emit(event: RequestEventInput): Promise<void> {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('db down'));
        written.push(event.requestId);
        return Promise.resolve();
      },
    };
    const buffer = new RequestEventBuffer(flaky);
    buffer.capture(base('fails'));
    buffer.capture(base('lands'));
    await buffer.close();

    expect(buffer.failedTotal).toBe(1);
    expect(written).toEqual(['lands']);
  });

  it('capture after close is dropped', async () => {
    const store = new InMemoryRequestEventStore();
    const buffer = new RequestEventBuffer(store);
    await buffer.close();
    buffer.capture(base('late'));
    expect(buffer.droppedTotal).toBe(1);
    expect(await store.list({ org: 'acme' })).toHaveLength(0);
  });
});

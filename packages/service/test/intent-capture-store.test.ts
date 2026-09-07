import type { IntentEventInput } from '@noodle-borg/module';
import {
  InMemoryIntentCaptureSettingsStore,
  InMemoryIntentEventStore,
  IntentEventBuffer,
} from '@noodle-borg/observability';
import { describe, expect, it } from 'vitest';

const ref = { org: 'acme', app: 'orders', env: 'production' } as const;
const event: IntentEventInput = {
  ...ref,
  protocolEra: 'modern',
  requestId: 'request-1',
  toolName: 'get_order',
  outcome: 'ok',
  category: 'support',
  match: 'direct',
  goal: 'Check an order status',
  source: 'tool_schema',
};

describe('intent capture stores', () => {
  it('defaults settings off and persists an explicit environment mode', async () => {
    const store = new InMemoryIntentCaptureSettingsStore();
    await expect(store.get(ref)).resolves.toBeUndefined();
    await expect(store.set(ref, 'starter-v1', 'owner-1')).resolves.toMatchObject({
      ...ref,
      mode: 'starter-v1',
      updatedBySubject: 'owner-1',
    });
    await expect(store.get(ref)).resolves.toMatchObject({ mode: 'starter-v1' });
    await store.delete(ref);
    await expect(store.get(ref)).resolves.toBeUndefined();
  });

  it('stores intent separately, filters tenant data, and purges an exact environment', async () => {
    const store = new InMemoryIntentEventStore();
    await store.emit(event);
    await store.emit({ ...event, app: 'other', requestId: 'request-2' });

    const listed = await store.list(ref);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject(event);
    await expect(store.purge(ref)).resolves.toBe(1);
    await expect(store.list(ref)).resolves.toEqual([]);
  });

  it('buffers capture without making store failures observable to callers', async () => {
    const buffer = new IntentEventBuffer({ emit: () => Promise.reject(new Error('down')) });
    expect(() => buffer.capture(event)).not.toThrow();
    await buffer.close();
    expect(buffer.failedTotal).toBe(1);
  });
});

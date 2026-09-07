import { afterEach, describe, expect, it, vi } from 'vitest';
import { boundedAssistantExecution } from '../src/assistant-execution-bound.js';

describe('accepted assistant execution bound', () => {
  afterEach(() => vi.useRealTimers());
  it('aborts ambiguous work at its bound and returns an unknown outcome without retrying', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const work = vi.fn(async (value: AbortSignal) => {
      signal = value;
      return new Promise<string>(() => {});
    });
    const result = boundedAssistantExecution(work, () => 'unknown', 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toBe('unknown');
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({ name: 'TimeoutError' });
    expect(work).toHaveBeenCalledTimes(1);
  });
  it('preserves a completed result and releases the deadline timer', async () => {
    vi.useFakeTimers();
    expect(
      await boundedAssistantExecution(
        async () => 'completed',
        () => 'unknown',
        10,
      ),
    ).toBe('completed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('treats thrown execution as unknown and refuses limits exceeding the stored bound', async () => {
    expect(
      await boundedAssistantExecution(
        async () => {
          throw new Error('opaque transport failure');
        },
        () => 'unknown',
      ),
    ).toBe('unknown');
    await expect(
      boundedAssistantExecution(
        async () => 'done',
        () => 'unknown',
        120_001,
      ),
    ).rejects.toThrow('Invalid assistant execution bound');
  });
});

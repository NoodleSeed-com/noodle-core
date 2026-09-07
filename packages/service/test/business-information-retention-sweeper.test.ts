import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drainExpiredContent,
  retentionSweepTrigger,
} from '../src/business-information/retention-sweeper.js';

describe('business information retention sweeper', () => {
  afterEach(() => vi.useRealTimers());
  it('drains every bounded page from each store', async () => {
    const first = { purgeExpired: vi.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1) };
    const second = {
      purgeExpired: vi
        .fn()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0),
    };

    await expect(drainExpiredContent([first, second], { batchSize: 2 })).resolves.toEqual({
      purged: 7,
      hasMore: false,
    });
    expect(first.purgeExpired).toHaveBeenCalledTimes(2);
    expect(second.purgeExpired).toHaveBeenCalledTimes(3);
    expect(first.purgeExpired).toHaveBeenCalledWith({ limit: 2 });
  });

  it('bounds a continuously full backlog and reports work remaining instead of draining forever', async () => {
    const store = { purgeExpired: vi.fn().mockResolvedValue(2) };
    await expect(drainExpiredContent([store], { batchSize: 2, maxBatches: 3 })).resolves.toEqual({
      purged: 6,
      hasMore: true,
    });
    expect(store.purgeExpired).toHaveBeenCalledTimes(3);
  });

  it('also stops at the elapsed work budget between batches', async () => {
    let now = 0;
    const store = {
      purgeExpired: vi.fn(async () => {
        now += 600;
        return 2;
      }),
    };
    await expect(
      drainExpiredContent([store], { batchSize: 2, timeBudgetMs: 1_000, now: () => now }),
    ).resolves.toEqual({ purged: 4, hasMore: true });
    expect(store.purgeExpired).toHaveBeenCalledTimes(2);
  });

  it('continues a bounded backlog promptly and cancels scheduled work on shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = { purgeExpired: vi.fn().mockResolvedValue(1) };
    const trigger = retentionSweepTrigger([store], { error: vi.fn() }, 1);
    trigger();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    expect(store.purgeExpired).toHaveBeenCalledTimes(20);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(store.purgeExpired).toHaveBeenCalledTimes(40));
    trigger.close();
    await vi.advanceTimersByTimeAsync(60_000);
    trigger();
    expect(store.purgeExpired).toHaveBeenCalledTimes(40);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs only a fixed diagnostic for untrusted store errors and cancels an in-flight continuation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logger = { error: vi.fn() };
    const providerError = new Error('PRIVATE_RECORD_AND_CREDENTIAL');
    providerError.name = 'PRIVATE_PROVIDER_NAME';
    const trigger = retentionSweepTrigger(
      [{ purgeExpired: vi.fn().mockRejectedValue(providerError) }],
      logger,
    );
    trigger();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(logger.error).toHaveBeenCalledWith('business_information.retention.failed', {
      code: 'retention_sweep_failed',
    });
    trigger.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces overlapping triggers while an asynchronous drain is active', async () => {
    let release: ((count: number) => void) | undefined;
    const store = {
      purgeExpired: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const trigger = retentionSweepTrigger([store], { error: vi.fn() }, 10);

    trigger();
    trigger();
    expect(store.purgeExpired).toHaveBeenCalledTimes(1);
    release?.(0);
    await vi.waitFor(() => expect(store.purgeExpired).toHaveBeenCalledTimes(1));
    trigger.close();
  });
});

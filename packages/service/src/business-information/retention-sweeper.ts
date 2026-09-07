export interface ExpiredContentStore {
  purgeExpired(input: { readonly limit?: number }): Promise<number>;
}

export interface RetentionSweepLogger {
  error(message: string, fields: Readonly<Record<string, unknown>>): void;
}

interface RetentionPassOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
  readonly timeBudgetMs?: number;
  readonly now?: () => number;
}

interface RetentionPassResult {
  readonly purged: number;
  readonly hasMore: boolean;
}

/** A bounded pass yields between pages; the existing worker schedules any remaining backlog. */
export async function drainExpiredContent(
  stores: readonly (ExpiredContentStore | undefined)[],
  options: RetentionPassOptions = {},
): Promise<RetentionPassResult> {
  const { batchSize = 100, maxBatches = 20, timeBudgetMs = 1_000, now = Date.now } = options;
  if (
    ![batchSize, maxBatches, timeBudgetMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error('invalid retention work budget');
  const deadline = now() + timeBudgetMs;
  const totals = await Promise.all(
    stores
      .filter((store) => store !== undefined)
      .map((store) => drainStore(store, batchSize, maxBatches, deadline, now)),
  );
  return {
    purged: totals.reduce((total, result) => total + result.purged, 0),
    hasMore: totals.some((result) => result.hasMore),
  };
}

export interface RetentionSweep {
  (): void;
  close(): void;
}

/** Coalesces boot and interval triggers while the previous asynchronous drain is still active. */
export function retentionSweepTrigger(
  stores: readonly (ExpiredContentStore | undefined)[],
  logger: RetentionSweepLogger,
  batchSize = 100,
): RetentionSweep {
  let running = false;
  let closed = false;
  let continuation: NodeJS.Timeout | undefined;
  const schedule = (delay: number) => {
    if (closed) return;
    continuation = setTimeout(trigger, delay);
    continuation.unref?.();
  };
  const trigger = () => {
    if (running || closed) return;
    clearTimeout(continuation);
    continuation = undefined;
    running = true;
    void drainExpiredContent(stores, { batchSize })
      .then((result) => {
        if (result.hasMore) schedule(1_000);
      })
      .catch(() => {
        logger.error('business_information.retention.failed', {
          code: 'retention_sweep_failed',
        });
        schedule(30_000);
      })
      .finally(() => {
        running = false;
      });
  };
  trigger.close = () => {
    closed = true;
    clearTimeout(continuation);
    continuation = undefined;
  };
  return trigger;
}

async function drainStore(
  store: ExpiredContentStore,
  batchSize: number,
  maxBatches: number,
  deadline: number,
  now: () => number,
): Promise<RetentionPassResult> {
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch++) {
    const count = await store.purgeExpired({ limit: batchSize });
    if (!Number.isSafeInteger(count) || count < 0 || count > batchSize)
      throw new Error('invalid retention batch result');
    total += count;
    if (count < batchSize) return { purged: total, hasMore: false };
    if (now() >= deadline) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { purged: total, hasMore: true };
}

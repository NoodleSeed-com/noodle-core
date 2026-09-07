import { expect, it } from 'vitest';
import {
  type AtomicDailyCounterStore,
  type DailyCounterStore,
  hourKey,
} from '../src/counter-store.js';

/**
 * One behavioural contract, run against every implementation. A store that passes this is
 * interchangeable at the admission seam; anything asserted only against the in-memory store would be a
 * property the durable path is free to violate in production, which is the direction that matters.
 */
export function describeCounterStore(makeStore: () => Promise<DailyCounterStore>): void {
  const day = new Date('2030-03-04T09:00:00Z');

  it('uses distinct UTC minute, hour and day rows and reports the minute reset', async () => {
    const store = await makeStore();
    const key = `minute-${Math.random()}`;
    expect(await store.consume({ key, limit: 1, window: 'minute' }, day)).toMatchObject({
      allowed: true,
    });
    expect(await store.consume({ key, limit: 1, window: 'minute' }, day)).toMatchObject({
      allowed: false,
      resetAt: new Date('2030-03-04T09:01:00Z'),
    });
    expect(await store.consume({ key, limit: 1, window: 'hour' }, day)).toMatchObject({
      allowed: true,
    });
    expect(await store.consume({ key, limit: 1 }, day)).toMatchObject({ allowed: true });
    expect(
      await store.consume({ key, limit: 1, window: 'minute' }, new Date('2030-03-04T09:01:00Z')),
    ).toMatchObject({ allowed: true });
  });

  it('consumes up to the limit and then denies', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    expect(await store.consume({ key, limit: 2 }, day)).toMatchObject({ allowed: true, used: 1 });
    expect(await store.consume({ key, limit: 2 }, day)).toMatchObject({ allowed: true, used: 2 });
    expect(await store.consume({ key, limit: 2 }, day)).toMatchObject({ allowed: false, used: 2 });
    expect(await store.peek(key, day)).toBe(2);
  });

  it('denies a first request larger than the whole budget', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    // The opening call takes the insert path, where a missing ceiling test would admit it once.
    expect(await store.consume({ key, limit: 3, amount: 5 }, day)).toMatchObject({
      allowed: false,
    });
    expect(await store.peek(key, day)).toBe(0);
  });

  it('treats a zero limit as switched off', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    expect(await store.consume({ key, limit: 0 }, day)).toMatchObject({ allowed: false, used: 0 });
  });

  it('keys counters per day and reports the next UTC rollover', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    await store.consume({ key, limit: 1 }, day);
    expect(await store.consume({ key, limit: 1 }, day)).toMatchObject({ allowed: false });

    const nextDay = new Date('2030-03-05T00:30:00Z');
    const rolled = await store.consume({ key, limit: 1 }, nextDay);
    expect(rolled.allowed).toBe(true);
    expect(rolled.resetAt.toISOString()).toBe('2030-03-06T00:00:00.000Z');
    // Yesterday's usage is untouched, so a rollover is not a reset of history.
    expect(await store.peek(key, day)).toBe(1);
  });

  it('keeps separate keys independent', async () => {
    const store = await makeStore();
    const a = `k-${Math.random()}`;
    const b = `k-${Math.random()}`;
    await store.consume({ key: a, limit: 1 }, day);
    expect(await store.consume({ key: b, limit: 1 }, day)).toMatchObject({ allowed: true });
  });

  it('never exceeds the limit under concurrent consumption', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    const limit = 10;
    const outcomes = await Promise.all(
      Array.from({ length: 40 }, () => store.consume({ key, limit }, day)),
    );
    expect(outcomes.filter((outcome) => outcome.allowed)).toHaveLength(limit);
    expect(await store.peek(key, day)).toBe(limit);
  });

  it('counts an hourly window against real storage, not just a key string', async () => {
    // This suite only ever exercised the daily window, and the per-address tier's route tests used a
    // mocked counter — so an hourly request never reached real SQL until production did, where the
    // `day` column is a genuine `date` and an hour-resolution value fails to cast. Every window the
    // port offers has to be proven against every store, or the durable path is free to reject one.
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    const at = new Date('2026-08-14T07:30:00.000Z');

    expect(await store.consume({ key, limit: 2, window: 'hour' }, at)).toMatchObject({
      allowed: true,
      used: 1,
    });
    expect(await store.consume({ key, limit: 2, window: 'hour' }, at)).toMatchObject({
      allowed: true,
      used: 2,
    });
    // A denied hourly request must report what it actually used, not zero.
    expect(await store.consume({ key, limit: 2, window: 'hour' }, at)).toMatchObject({
      allowed: false,
      used: 2,
    });
  });

  it('rolls an hourly window at the hour and keeps it apart from the daily one', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    const first = new Date('2026-08-14T07:30:00.000Z');
    const later = new Date('2026-08-14T08:00:00.000Z');

    expect(await store.consume({ key, limit: 1, window: 'hour' }, first)).toMatchObject({
      allowed: true,
    });
    expect(await store.consume({ key, limit: 1, window: 'hour' }, first)).toMatchObject({
      allowed: false,
    });
    // The next hour is a fresh allowance...
    expect(await store.consume({ key, limit: 1, window: 'hour' }, later)).toMatchObject({
      allowed: true,
    });
    // ...and the same key's daily counter is untouched by any of it.
    expect(await store.consume({ key, limit: 1 }, first)).toMatchObject({ allowed: true });
  });

  /**
   * The table takes a write on every mint and every turn, and tier-3 and tier-4 rows are hourly, so a
   * busy surface writes up to 24 rows per visitor per day. Nothing pruned them.
   *
   * What makes the prune trivially safe is that both windows record the same `day`: an hourly row
   * carries its hour inside the key, so a row whose day is behind the retention cutoff can never be
   * consulted by any reader again.
   */
  it('prunes rows no reader can reach, and keeps the ones that are still live', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    const old = new Date('2030-03-01T09:00:00Z');

    await store.consume({ key, limit: 5 }, old);
    await store.consume({ key, limit: 5, window: 'hour' }, old);
    await store.consume({ key, limit: 5 }, day);
    expect(await store.peek(key, old)).toBe(1);

    const removed = await store.prune(day);

    expect(await store.peek(key, old)).toBe(0);
    // The hourly row too, by its own folded key. Peeking only the daily one let a store that leaked
    // every hourly row — the bulk of the table, twenty-four a day per visitor — pass this suite.
    expect(await store.peek(`${key}@${hourKey(old)}`, old)).toBe(0);
    expect(removed).toBeGreaterThanOrEqual(2);
    // Today's allowance is untouched: pruning must never hand a surface a fresh budget.
    expect(await store.peek(key, day)).toBe(1);
  });

  it('keeps a grace window rather than pruning at the stroke of midnight', async () => {
    const store = await makeStore();
    const key = `k-${Math.random()}`;
    const yesterday = new Date('2030-03-03T23:59:00Z');

    await store.consume({ key, limit: 5 }, yesterday);
    await store.prune(day);

    // Instances disagree about the clock and requests are in flight across the boundary; deleting a
    // row the moment it stops being today's would race both.
    expect(await store.peek(key, yesterday)).toBe(1);
  });
}

/** The stronger all-or-nothing contract used when one sponsored call spends two ceilings. */
export function describeAtomicCounterStore(
  makeStore: () => Promise<AtomicDailyCounterStore>,
): void {
  const day = new Date('2030-03-04T09:00:00Z');

  it('consumes every requested ceiling together', async () => {
    const store = await makeStore();
    const account = `account-${Math.random()}`;
    const fleet = `fleet-${Math.random()}`;

    await expect(
      store.consumeAll(
        [
          { key: account, limit: 10, amount: 3 },
          { key: fleet, limit: 100, amount: 3 },
        ],
        day,
      ),
    ).resolves.toBe(true);
    await expect(store.peek(account, day)).resolves.toBe(3);
    await expect(store.peek(fleet, day)).resolves.toBe(3);
  });

  it('rolls every counter back when one ceiling refuses', async () => {
    const store = await makeStore();
    const account = `account-${Math.random()}`;
    const fleet = `fleet-${Math.random()}`;
    await store.consume({ key: fleet, limit: 3, amount: 3 }, day);

    await expect(
      store.consumeAll(
        [
          { key: account, limit: 10, amount: 2 },
          { key: fleet, limit: 3, amount: 2 },
        ],
        day,
      ),
    ).resolves.toBe(false);
    await expect(store.peek(account, day)).resolves.toBe(0);
    await expect(store.peek(fleet, day)).resolves.toBe(3);
  });

  it('never partially admits concurrent batches sharing one global ceiling', async () => {
    const store = await makeStore();
    const fleet = `fleet-${Math.random()}`;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.consumeAll(
          [
            { key: `account-${index}-${Math.random()}`, limit: 1 },
            { key: fleet, limit: 5 },
          ],
          day,
        ),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(5);
    await expect(store.peek(fleet, day)).resolves.toBe(5);
  });

  it('spends an equal logical attempt once and conflicts on changed content', async () => {
    const store = await makeStore();
    const surface = `surface-${Math.random()}`;
    const attempt = { key: `attempt-${Math.random()}`, fingerprint: 'a'.repeat(64) };
    const requests = [{ key: surface, limit: 10 }] as const;

    await expect(store.consumeAllOnce(requests, attempt, day)).resolves.toEqual({
      kind: 'consumed',
    });
    await expect(store.consumeAllOnce(requests, attempt, day)).resolves.toEqual({
      kind: 'replayed',
    });
    await expect(
      store.consumeAllOnce(requests, { ...attempt, fingerprint: 'b'.repeat(64) }, day),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(store.peek(surface, day)).resolves.toBe(1);
  });

  it('serializes concurrent equal logical attempts without duplicate spend', async () => {
    const store = await makeStore();
    const surface = `surface-${Math.random()}`;
    const attempt = { key: `attempt-${Math.random()}`, fingerprint: 'c'.repeat(64) };
    const outcomes = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.consumeAllOnce([{ key: surface, limit: 20 }], attempt, day),
      ),
    );

    expect(outcomes.filter((outcome) => outcome.kind === 'consumed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'replayed')).toHaveLength(11);
    await expect(store.peek(surface, day)).resolves.toBe(1);
  });

  it('does not retain retry evidence or partially spend when a batch refuses', async () => {
    const store = await makeStore();
    const account = `account-${Math.random()}`;
    const fleet = `fleet-${Math.random()}`;
    const attempt = { key: `attempt-${Math.random()}`, fingerprint: 'd'.repeat(64) };
    await store.consume({ key: fleet, limit: 1 }, day);

    await expect(
      store.consumeAllOnce(
        [
          { key: account, limit: 1 },
          { key: fleet, limit: 1 },
        ],
        attempt,
        day,
      ),
    ).resolves.toMatchObject({ kind: 'refused', exhausted: [{ key: fleet, limit: 1 }] });
    await expect(store.peek(account, day)).resolves.toBe(0);

    const nextDay = new Date('2030-03-05T09:00:00Z');
    await expect(
      store.consumeAllOnce(
        [
          { key: account, limit: 1 },
          { key: fleet, limit: 1 },
        ],
        attempt,
        nextDay,
      ),
    ).resolves.toEqual({ kind: 'consumed' });
  });

  it('reports every exhausted window without spending available allowances', async () => {
    const store = await makeStore();
    const prefix = `all-windows-${Math.random()}`;
    await store.consume({ key: `${prefix}-minute`, limit: 1, window: 'minute' }, day);
    await store.consume({ key: `${prefix}-hour`, limit: 1, window: 'hour' }, day);
    const outcome = await store.consumeAllOnce(
      [
        { key: `${prefix}-minute`, limit: 1, window: 'minute' },
        { key: `${prefix}-hour`, limit: 1, window: 'hour' },
        { key: `${prefix}-day`, limit: 10 },
      ],
      { key: `${prefix}-attempt`, fingerprint: 'a'.repeat(64) },
      day,
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.exhausted).toEqual(
      expect.arrayContaining([
        { key: `${prefix}-minute`, limit: 1, resetAt: new Date('2030-03-04T09:01:00Z') },
        { key: `${prefix}-hour`, limit: 1, resetAt: new Date('2030-03-04T10:00:00Z') },
      ]),
    );
    expect(outcome.exhausted).toHaveLength(2);
    expect(await store.peek(`${prefix}-day`, day)).toBe(0);
  });
}

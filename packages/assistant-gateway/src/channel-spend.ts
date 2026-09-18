import { requireChannel, requireChannelLive } from './channel-coordinator.js';
import { channelCounter } from './channel-inbox.js';
import type { ChannelStore } from './channel-store.js';
import {
  CHANNEL_DAY_MS,
  CHANNEL_RETENTION_MS,
  ChannelError,
  type ChannelEvent,
  channelDigest,
  channelRow,
  channelValue,
} from './channel-types.js';

interface SpendAttempt {
  maximum: number;
  actual?: number;
  day: number;
}
interface SpendDay {
  reserved: number;
  spent: number;
}
const spendId = (attempt: string) => `spend:${channelDigest(attempt)}`;
const dayId = (day: number) => `spend-day:${day}`;
export async function reserveChannelSpend(
  store: ChannelStore,
  id: string,
  attempt: string,
  maximum: number,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    throw new ChannelError('spend_bound_unverified');
  await store.transaction([id], async (tx) => {
    const binding = await requireChannelLive(tx, id);
    const old = await channelValue<SpendAttempt>(tx, id, spendId(attempt));
    if (old) throw new ChannelError('spend_attempt_reused');
    const day = Math.floor(now / CHANNEL_DAY_MS);
    const usage = (await channelValue<SpendDay>(tx, id, dayId(day))) ?? { reserved: 0, spent: 0 };
    if (usage.reserved + usage.spent + maximum > binding.limits.dailyMicroUsd)
      throw new ChannelError('daily_spend_limit');
    await tx.put(
      id,
      channelRow(spendId(attempt), 'spend', { maximum, day }, now, {
        expiresAt: now + CHANNEL_RETENTION_MS,
      }),
    );
    await tx.put(
      id,
      channelRow(dayId(day), 'spend', { ...usage, reserved: usage.reserved + maximum }, now, {
        expiresAt: (day + 9) * CHANNEL_DAY_MS,
      }),
    );
  });
}
export async function settleChannelSpend(
  store: ChannelStore,
  id: string,
  attempt: string,
  actual: number,
  now: number,
): Promise<void> {
  if (!Number.isSafeInteger(actual) || actual < 0) throw new ChannelError('spend_usage_invalid');
  await store.transaction([id], async (tx) => {
    await requireChannel(tx, id);
    const record = await channelValue<SpendAttempt>(tx, id, spendId(attempt));
    if (!record) throw new ChannelError('spend_attempt_missing');
    if (record.actual !== undefined) {
      if (record.actual !== actual) throw new ChannelError('spend_settlement_conflict');
      return;
    }
    const usage = await channelValue<SpendDay>(tx, id, dayId(record.day));
    if (!usage) throw new ChannelError('spend_attempt_missing');
    await tx.put(
      id,
      channelRow(spendId(attempt), 'spend', { ...record, actual }, now, {
        expiresAt: now + CHANNEL_RETENTION_MS,
      }),
    );
    await tx.put(
      id,
      channelRow(
        dayId(record.day),
        'spend',
        { reserved: usage.reserved - record.maximum, spent: usage.spent + actual },
        now,
        { expiresAt: (record.day + 9) * CHANNEL_DAY_MS },
      ),
    );
    // Record actual cost even when a deployment's declared bound was violated, then stop this channel.
    if (actual > record.maximum) {
      const binding = await requireChannel(tx, id);
      await tx.put(
        id,
        channelRow(
          'binding',
          'binding',
          {
            ...binding,
            state: 'paused',
            generation: binding.generation + 1,
            revision: binding.revision + 1,
          },
          now,
        ),
      );
    }
  });
}
export async function channelUsage(store: ChannelStore, id: string, now: number) {
  return store.transaction([id], async (tx) => {
    const binding = await requireChannel(tx, id);
    const day = Math.floor(now / CHANNEL_DAY_MS);
    const usage = (await channelValue<SpendDay>(tx, id, dayId(day))) ?? { reserved: 0, spent: 0 };
    const pending: ChannelEvent[] = [];
    for (const state of ['queued', 'running', 'reply', 'sending'])
      pending.push(
        ...(await tx.list(id, { kind: 'event', state, limit: 1000 })).map(
          (row) => row.value as ChannelEvent,
        ),
      );
    return {
      resetAt: (day + 1) * CHANNEL_DAY_MS,
      admittedToday: await channelCounter(tx, id, 'all', now, CHANNEL_DAY_MS),
      newParticipantsToday: await channelCounter(tx, id, 'new', now, CHANNEL_DAY_MS),
      pending: pending.length,
      oldestPendingAt: pending.length
        ? Math.min(...pending.map((event) => event.receivedAt))
        : null,
      unknownSends: await tx.count(id, 'event', 'unknown', now),
      day: new Date(day * CHANNEL_DAY_MS).toISOString().slice(0, 10),
      dailyMicroUsd: binding.limits.dailyMicroUsd,
      reservedMicroUsd: usage.reserved,
      spentMicroUsd: usage.spent,
    };
  });
}

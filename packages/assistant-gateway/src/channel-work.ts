import { randomUUID } from 'node:crypto';
import { channelBlocked, requireChannel } from './channel-coordinator.js';
import { channelCounter } from './channel-inbox.js';
import type { ChannelStore, ChannelTransaction } from './channel-store.js';
import {
  CHANNEL_DAY_MS,
  CHANNEL_RETENTION_MS,
  type ChannelBinding,
  ChannelError,
  type ChannelEvent,
  type ChannelParticipant,
  type ChannelReplyButton,
  channelDigest,
  channelRow,
  channelValue,
  writeChannelEvent,
} from './channel-types.js';

const LEASE_MS = 30_000;
export interface ChannelWork {
  readonly binding: ChannelBinding;
  readonly participant: ChannelParticipant;
  readonly event: ChannelEvent;
}
async function pendingEvents(tx: ChannelTransaction, id: string): Promise<ChannelEvent[]> {
  const events: ChannelEvent[] = [];
  for (const state of ['queued', 'running', 'reply', 'sending'])
    events.push(
      ...(await tx.list(id, { kind: 'event', state, limit: 1000 })).map(
        (row) => row.value as ChannelEvent,
      ),
    );
  return events.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
async function disallowed(
  tx: ChannelTransaction,
  binding: ChannelBinding,
  event: ChannelEvent,
  now: number,
): Promise<string | undefined> {
  if (
    binding.state !== 'enabled' ||
    binding.generation !== event.generation ||
    binding.deploymentId !== event.deploymentId
  )
    return 'authority_changed';
  if (await channelBlocked(tx, binding.id, event.participantId, now)) return 'blocked';
  return undefined;
}
async function reconcile(
  tx: ChannelTransaction,
  binding: ChannelBinding,
  now: number,
): Promise<ChannelEvent[]> {
  const pending = await pendingEvents(tx, binding.id);
  const live: ChannelEvent[] = [];
  for (const event of pending) {
    const invalid = await disallowed(tx, binding, event, now);
    let updated = event;
    if (event.state === 'sending') {
      if ((event.leaseUntil ?? 0) <= now)
        updated = { ...event, state: 'unknown', code: 'send_lease_expired' };
    } else if (invalid) updated = { ...event, state: 'cancelled', code: invalid };
    else if (event.state === 'running' && (event.leaseUntil ?? 0) <= now)
      updated = {
        ...event,
        state: event.attempts >= 3 || now - event.receivedAt > 300_000 ? 'failed' : 'queued',
        code: 'worker_lease_expired',
      };
    else if (
      (event.state === 'queued' || event.state === 'reply') &&
      now - event.receivedAt > 300_000
    )
      updated = { ...event, state: 'expired', code: 'work_deadline' };
    if (updated !== event) await writeChannelEvent(tx, binding.id, updated, now);
    if (['queued', 'running', 'reply', 'sending'].includes(updated.state)) live.push(updated);
  }
  return live;
}
export async function claimChannelTurn(
  store: ChannelStore,
  id: string,
  now: number,
  retentionMs = CHANNEL_RETENTION_MS,
): Promise<ChannelWork | undefined> {
  return store.transaction([id], async (tx) => {
    const binding = await requireChannel(tx, id);
    const events = await reconcile(tx, binding, now);
    if (
      binding.state !== 'enabled' ||
      events.filter((event) => event.state === 'running').length >= binding.limits.concurrent
    )
      return undefined;
    const candidate = events.find(
      (event, index) =>
        event.state === 'queued' &&
        !events.slice(0, index).some((older) => older.participantId === event.participantId),
    );
    if (!candidate) return undefined;
    const participant = await channelValue<ChannelParticipant>(tx, id, candidate.participantId);
    if (!participant || participant.lastInboundAt < now - retentionMs) {
      await writeChannelEvent(
        tx,
        id,
        { ...candidate, state: 'cancelled', code: 'context_expired' },
        now,
      );
      return undefined;
    }
    const event: ChannelEvent = {
      ...candidate,
      state: 'running',
      attempts: candidate.attempts + 1,
      lease: randomUUID(),
      leaseUntil: now + LEASE_MS,
      turnDeadline: now + 60_000,
    };
    await writeChannelEvent(tx, id, event, now);
    return {
      binding,
      event,
      participant: {
        ...participant,
        history: participant.history.filter((entry) => entry.at > now - retentionMs).slice(-20),
      },
    };
  });
}
async function leased(
  tx: ChannelTransaction,
  id: string,
  eventId: string,
  lease: string,
  now: number,
): Promise<ChannelEvent> {
  const event = await channelValue<ChannelEvent>(tx, id, eventId);
  if (
    !event ||
    event.state !== 'running' ||
    event.lease !== lease ||
    (event.leaseUntil ?? 0) <= now ||
    (event.turnDeadline ?? 0) <= now
  )
    throw new ChannelError('lease_lost');
  if (await disallowed(tx, await requireChannel(tx, id), event, now))
    throw new ChannelError('authority_changed');
  return event;
}
export async function renewChannelTurn(
  store: ChannelStore,
  id: string,
  eventId: string,
  lease: string,
  now: number,
): Promise<void> {
  await store.transaction([id], async (tx) => {
    const event = await leased(tx, id, eventId, lease, now);
    await writeChannelEvent(
      tx,
      id,
      { ...event, leaseUntil: Math.min(now + LEASE_MS, event.turnDeadline!) },
      now,
    );
  });
}
/** Text the transcript keeps instead of the raw message or the sent reply, e.g. with private values redacted. */
export interface ChannelTranscript {
  readonly user?: string;
  readonly assistant?: string;
}
export async function completeChannelTurn(
  store: ChannelStore,
  id: string,
  eventId: string,
  lease: string,
  reply: string,
  now: number,
  retentionMs = CHANNEL_RETENTION_MS,
  code?: string,
  transcript: ChannelTranscript = {},
  buttons?: readonly ChannelReplyButton[],
): Promise<void> {
  if (!reply.trim() || reply.length > 4096) throw new ChannelError('reply_invalid');
  await store.transaction([id], async (tx) => {
    const event = await leased(tx, id, eventId, lease, now);
    const participant = await channelValue<ChannelParticipant>(tx, id, event.participantId);
    if (!participant) throw new ChannelError('context_expired');
    const userText = transcript.user ?? event.text ?? '';
    const history = [
      ...participant.history.filter((entry) => entry.at > now - retentionMs),
      { role: 'user' as const, content: userText, at: event.receivedAt },
      { role: 'assistant' as const, content: transcript.assistant ?? reply, at: now },
    ].slice(-20);
    await tx.put(
      id,
      channelRow(participant.id, 'participant', { ...participant, history }, now, {
        expiresAt: participant.lastInboundAt + retentionMs,
      }),
    );
    await writeChannelEvent(
      tx,
      id,
      {
        ...event,
        ...(event.text === undefined ? {} : { text: userText }),
        reply,
        ...(transcript.assistant !== undefined && transcript.assistant !== reply
          ? { replyTranscript: transcript.assistant }
          : {}),
        ...(buttons !== undefined && buttons.length > 0 ? { buttons } : {}),
        state: 'reply',
        lease: undefined,
        leaseUntil: undefined,
        ...(code ? { code } : {}),
      },
      now,
    );
  });
}
export async function prepareChannelSend(
  store: ChannelStore,
  id: string,
  now: number,
): Promise<ChannelWork | undefined> {
  return store.transaction([id], async (tx) => {
    const binding = await requireChannel(tx, id);
    const events = await reconcile(tx, binding, now);
    if (binding.state !== 'enabled') return undefined;
    const candidate = events.find(
      (event, index) =>
        event.state === 'reply' &&
        !events.slice(0, index).some((older) => older.participantId === event.participantId),
    );
    if (!candidate) return undefined;
    const participant = await channelValue<ChannelParticipant>(tx, id, candidate.participantId);
    if (!participant || participant.lastInboundAt + CHANNEL_DAY_MS <= now) {
      await writeChannelEvent(
        tx,
        id,
        { ...candidate, state: 'expired', code: 'reply_window_closed' },
        now,
      );
      return undefined;
    }
    const event: ChannelEvent = {
      ...candidate,
      state: 'sending',
      lease: randomUUID(),
      leaseUntil: now + LEASE_MS,
    };
    await writeChannelEvent(tx, id, event, now);
    return { binding, event, participant };
  });
}
export async function updateChannelSend(
  store: ChannelStore,
  id: string,
  eventId: string,
  lease: string,
  result: { state: 'accepted' | 'unknown' | 'failed'; providerMessageId?: string; code?: string },
  now: number,
): Promise<void> {
  await store.transaction([id], async (tx) => {
    const event = await channelValue<ChannelEvent>(tx, id, eventId);
    if (!event || event.lease !== lease || !['sending', 'unknown'].includes(event.state))
      throw new ChannelError('lease_lost');
    if (result.state === 'accepted' && !result.providerMessageId)
      throw new ChannelError('provider_receipt_missing');
    const early = result.providerMessageId
      ? await channelValue<'delivered' | 'read' | 'failed' | 'sent'>(
          tx,
          id,
          `delivery:${channelDigest(result.providerMessageId)}`,
        )
      : undefined;
    // Once dispatch has been attempted the sent text and its buttons are never needed again: the
    // row keeps only what the transcript keeps, so a redacted reply does not outlive its delivery.
    const { replyTranscript: _kept, buttons: _offered, ...dispatched } = event;
    await writeChannelEvent(
      tx,
      id,
      {
        ...dispatched,
        ...(event.replyTranscript === undefined ? {} : { reply: event.replyTranscript }),
        ...result,
        ...(early && early !== 'sent' ? { state: early } : {}),
        leaseUntil: undefined,
      },
      now,
    );
    if (result.providerMessageId)
      await tx.put(
        id,
        channelRow(`receipt:${channelDigest(result.providerMessageId)}`, 'mutation', eventId, now, {
          expiresAt: event.receivedAt + CHANNEL_RETENTION_MS,
        }),
      );
  });
}
export async function recordChannelDelivery(
  store: ChannelStore,
  id: string,
  providerMessageId: string,
  state: 'sent' | 'delivered' | 'read' | 'failed',
  now: number,
): Promise<void> {
  await store.transaction([id], async (tx) => {
    await requireChannel(tx, id);
    const eventId = await channelValue<string>(
      tx,
      id,
      `receipt:${channelDigest(providerMessageId)}`,
    );
    if (!eventId) {
      // A delivery callback can beat the response that supplies its message id. Bound this
      // authenticated evidence separately, then join it when the acceptance receipt commits.
      const key = `delivery:${channelDigest(providerMessageId)}`;
      const prior = await channelValue<'sent' | 'delivered' | 'read' | 'failed'>(tx, id, key);
      if (!prior) {
        if ((await channelCounter(tx, id, 'delivery-ingress', now, CHANNEL_DAY_MS)) >= 10_000)
          throw new ChannelError('ingress_capacity');
        await channelCounter(tx, id, 'delivery-ingress', now, CHANNEL_DAY_MS, 1);
      }
      const order = { sent: 0, failed: 1, delivered: 2, read: 3 };
      if (!prior || order[state] > order[prior])
        await tx.put(
          id,
          channelRow(key, 'mutation', state, now, { expiresAt: now + CHANNEL_RETENTION_MS }),
        );
      return;
    }
    const event = await channelValue<ChannelEvent>(tx, id, eventId);
    if (!event) return;
    const next = state === 'sent' ? 'accepted' : state;
    const rank = { sending: 0, unknown: 0, accepted: 1, failed: 2, delivered: 3, read: 4 };
    if (!(event.state in rank) || rank[next] <= rank[event.state as keyof typeof rank]) return;
    await writeChannelEvent(tx, id, { ...event, state: next }, now);
  });
}

/** Last local fence before the adapter starts external IO; already dispatched work cannot be recalled. */
export async function assertChannelSend(
  store: ChannelStore,
  id: string,
  eventId: string,
  lease: string,
  now: number,
): Promise<void> {
  await store.transaction([id], async (tx) => {
    const event = await channelValue<ChannelEvent>(tx, id, eventId);
    const binding = await requireChannel(tx, id);
    if (
      !event ||
      event.state !== 'sending' ||
      event.lease !== lease ||
      (event.leaseUntil ?? 0) <= now
    )
      throw new ChannelError('lease_lost');
    if (await disallowed(tx, binding, event, now)) throw new ChannelError('authority_changed');
    const participant = await channelValue<ChannelParticipant>(tx, id, event.participantId);
    if (!participant || participant.lastInboundAt + CHANNEL_DAY_MS <= now)
      throw new ChannelError('reply_window_closed');
  });
}

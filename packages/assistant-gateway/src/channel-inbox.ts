import { channelBlocked, requireChannel } from './channel-coordinator.js';
import type { ChannelStore, ChannelTransaction } from './channel-store.js';
import {
  CHANNEL_DAY_MS,
  CHANNEL_RETENTION_MS,
  type ChannelBinding,
  ChannelError,
  type ChannelEvent,
  type ChannelInbound,
  type ChannelParticipant,
  channelDigest,
  channelParticipantId,
  channelRow,
  channelValue,
  writeChannelEvent,
} from './channel-types.js';

export async function channelCounter(
  tx: ChannelTransaction,
  scope: string,
  key: string,
  now: number,
  period: number,
  add = 0,
): Promise<number> {
  const bucket = Math.floor(now / period);
  const id = `counter:${key}:${period}:${bucket}`;
  const value = ((await channelValue<number>(tx, scope, id)) ?? 0) + add;
  if (add)
    await tx.put(
      scope,
      channelRow(id, 'counter', value, now, { expiresAt: (bucket + 2) * period }),
    );
  return value;
}
async function refusal(
  tx: ChannelTransaction,
  binding: ChannelBinding,
  message: ChannelInbound,
  participant: string,
  pending: readonly ChannelEvent[],
  now: number,
): Promise<string | undefined> {
  if (binding.state !== 'enabled') return 'channel_paused';
  if (await channelBlocked(tx, binding.id, participant, now)) return 'blocked';
  if (message.eventAt < now - CHANNEL_RETENTION_MS || message.eventAt > now + 60_000)
    return 'timestamp_invalid';
  const record = await channelValue<ChannelParticipant>(tx, binding.id, participant);
  if (record?.cooldownUntil && record.cooldownUntil > now) return 'cooldown';
  if (
    pending.length >= binding.limits.pending ||
    pending.filter((event) => event.participantId === participant).length >=
      binding.limits.pendingPerParticipant
  )
    return 'queue_full';
  for (const [key, period, maximum] of [
    [participant, 60_000, binding.limits.perMinute],
    [participant, 3_600_000, binding.limits.perHour],
    [participant, CHANNEL_DAY_MS, binding.limits.perDay],
    ['all', CHANNEL_DAY_MS, binding.limits.channelPerDay],
    ...(!record ? [['new', CHANNEL_DAY_MS, binding.limits.newParticipantsPerDay] as const] : []),
  ] as const)
    if ((await channelCounter(tx, binding.id, key, now, period)) >= maximum)
      return period === 60_000 ? 'minute_limited' : 'rate_limited';
  return undefined;
}
/** Returns content-free admission receipts; callback retries never recover or expose message bodies. */
export async function receiveChannelMessages(
  store: ChannelStore,
  id: string,
  messages: readonly ChannelInbound[],
  now: number,
  retentionMs = CHANNEL_RETENTION_MS,
) {
  if (messages.length > 100) throw new ChannelError('batch_too_large');
  return store.transaction([id], async (tx) => {
    const binding = await requireChannel(tx, id);
    const pending: ChannelEvent[] = [];
    for (const state of ['queued', 'running', 'reply', 'sending'])
      pending.push(
        ...(await tx.list(id, { kind: 'event', state, limit: 1000 })).map(
          (row) => row.value as ChannelEvent,
        ),
      );
    const receipts: Array<Pick<ChannelEvent, 'id' | 'participantId' | 'state' | 'code'>> = [];
    for (const message of messages) {
      if (
        !message.providerId ||
        message.providerId.length > 512 ||
        !message.address.value ||
        message.address.value.length > 128 ||
        !Number.isSafeInteger(message.eventAt)
      )
        throw new ChannelError('message_invalid');
      const seenId = `seen:${channelDigest(message.providerId)}`;
      const fingerprint = channelDigest(JSON.stringify(message));
      const seen = await channelValue<{ fingerprint: string; receipt: (typeof receipts)[number] }>(
        tx,
        id,
        seenId,
      );
      if (seen) {
        if (seen.fingerprint !== fingerprint) throw new ChannelError('event_conflict');
        receipts.push(seen.receipt);
        continue;
      }
      // Bound even rejected anonymous traffic. Retryable overload acknowledges no uncommitted event.
      if ((await channelCounter(tx, id, 'ingress', now, CHANNEL_DAY_MS)) >= 10_000)
        throw new ChannelError('ingress_capacity');
      const participantId = channelParticipantId(binding, message.address);
      const code = await refusal(tx, binding, message, participantId, pending, now);
      const sequence = ((await channelValue<number>(tx, id, 'sequence')) ?? 0) + 1;
      await tx.put(id, channelRow('sequence', 'counter', sequence, now));
      const eventId = `e_${String(sequence).padStart(20, '0')}`;
      const unsupported =
        message.text === undefined || message.text.length > binding.limits.textCharacters;
      let event: ChannelEvent = {
        id: eventId,
        participantId,
        providerId: message.providerId,
        eventAt: Math.min(now, message.eventAt),
        receivedAt: now,
        generation: binding.generation,
        deploymentId: binding.deploymentId,
        attempts: 0,
        state: code ? 'refused' : unsupported ? 'reply' : 'queued',
        ...(code ? { code } : {}),
        ...(!code && !unsupported ? { text: message.text } : {}),
        ...(!code && unsupported
          ? {
              reply: `Please send a text message of up to ${binding.limits.textCharacters} characters. For help, contact ${binding.supportEmail}.`,
            }
          : {}),
      };
      if (code === 'minute_limited') {
        const row = await tx.get(id, participantId);
        if (row) {
          const participant = row.value as ChannelParticipant;
          const strikes = [...participant.strikes.filter((at) => at > now - 600_000), now].slice(
            -3,
          );
          await tx.put(id, {
            ...row,
            value: {
              ...participant,
              strikes,
              ...(strikes.length >= 3 ? { cooldownUntil: now + 600_000 } : {}),
            },
            updatedAt: now,
          });
        }
      }
      if (!code) {
        const stored = await channelValue<ChannelParticipant>(tx, id, participantId);
        const old = stored && stored.lastInboundAt > now - retentionMs ? stored : undefined;
        const sameDeployment = old?.deploymentId === binding.deploymentId;
        const participant: ChannelParticipant = {
          ...old,
          deploymentId: binding.deploymentId,
          modelToolUses: sameDeployment ? (old?.modelToolUses ?? []) : [],
          id: participantId,
          address: message.address,
          lastInboundAt: Math.max(old?.lastInboundAt ?? 0, event.eventAt),
          history: (sameDeployment ? (old?.history ?? []) : []).filter(
            (entry) => entry.at > now - retentionMs,
          ),
          strikes: old?.strikes ?? [],
        };
        await tx.put(
          id,
          channelRow(participantId, 'participant', participant, now, {
            expiresAt: now + CHANNEL_RETENTION_MS,
          }),
        );
        for (const period of [60_000, 3_600_000, CHANNEL_DAY_MS])
          await channelCounter(tx, id, participantId, now, period, 1);
        await channelCounter(tx, id, 'all', now, CHANNEL_DAY_MS, 1);
        if (!old) await channelCounter(tx, id, 'new', now, CHANNEL_DAY_MS, 1);
        pending.push(event);
      }
      if (
        code &&
        ['minute_limited', 'rate_limited', 'cooldown'].includes(code) &&
        pending.length < binding.limits.pending &&
        pending.filter((item) => item.participantId === participantId).length <
          binding.limits.pendingPerParticipant
      ) {
        const person = await channelValue<ChannelParticipant>(tx, id, participantId);
        if (
          person &&
          person.lastInboundAt + CHANNEL_DAY_MS > now &&
          (await channelCounter(tx, id, `notice:${participantId}`, now, 3_600_000)) < 1 &&
          (await channelCounter(tx, id, 'notices', now, CHANNEL_DAY_MS)) < 100
        ) {
          event = {
            ...event,
            state: 'reply',
            reply:
              'Please wait before sending another question. This assistant has reached a temporary limit.',
          };
          await channelCounter(tx, id, `notice:${participantId}`, now, 3_600_000, 1);
          await channelCounter(tx, id, 'notices', now, CHANNEL_DAY_MS, 1);
          pending.push(event);
        }
      }
      await writeChannelEvent(tx, id, event, now);
      const receipt = { id: eventId, participantId, state: event.state, ...(code ? { code } : {}) };
      await tx.put(
        id,
        channelRow(seenId, 'mutation', { fingerprint, receipt }, now, {
          expiresAt: now + CHANNEL_RETENTION_MS,
        }),
      );
      await channelCounter(tx, id, 'ingress', now, CHANNEL_DAY_MS, 1);
      receipts.push(receipt);
    }
    return receipts;
  });
}

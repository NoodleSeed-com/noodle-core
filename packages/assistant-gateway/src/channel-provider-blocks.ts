import { randomUUID } from 'node:crypto';
import { requireChannel } from './channel-coordinator.js';
import type { ChannelStore } from './channel-store.js';
import {
  CHANNEL_DAY_MS,
  CHANNEL_RETENTION_MS,
  ChannelError,
  type ChannelParticipant,
  channelDigest,
  channelParticipantId,
  channelRow,
  channelValue,
} from './channel-types.js';

export interface ChannelProviderBlock {
  readonly participantId: string;
  readonly desired: 'blocked' | 'unblocked';
  readonly state: 'pending' | 'confirmed' | 'error' | 'unknown';
  readonly actor: string;
  readonly updatedAt: number;
  readonly code?: string;
}
/** Explicit provider operations have their own evidence; local unblock never invokes this port. */
export async function beginChannelProviderBlock(
  store: ChannelStore,
  id: string,
  participantId: string,
  desired: ChannelProviderBlock['desired'],
  actor: string,
  key: string,
  now: number,
  protectedPhone?: string,
) {
  return store.transaction([id], async (tx) => {
    const binding = await requireChannel(tx, id);
    const receipt = `provider-mutation:${channelDigest(key)}`;
    const fingerprint = channelDigest(JSON.stringify([participantId, desired, actor]));
    const prior = await channelValue<{ fingerprint: string }>(tx, id, receipt);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new ChannelError('idempotency_conflict');
      return undefined;
    }
    const participant = await channelValue<ChannelParticipant>(tx, id, participantId);
    const address = protectedPhone
      ? { kind: 'phone' as const, value: protectedPhone.replace(/^\+/, '') }
      : participant?.address;
    if (
      !address ||
      address.kind !== 'phone' ||
      channelParticipantId(binding, address) !== participantId
    )
      throw new ChannelError('provider_recipient_unavailable');
    if (
      desired === 'blocked' &&
      (!participant || participant.lastInboundAt + CHANNEL_DAY_MS <= now)
    )
      throw new ChannelError('provider_block_window_closed');
    const existing = await channelValue<ChannelProviderBlock>(
      tx,
      id,
      `provider-block:${participantId}`,
    );
    if (existing?.state === 'pending' && now - existing.updatedAt < 30_000)
      throw new ChannelError('provider_operation_pending');
    if (
      desired === 'unblocked' &&
      (!existing || (existing.desired === 'unblocked' && existing.state === 'confirmed'))
    )
      throw new ChannelError('provider_block_not_owned');
    const operationId = randomUUID();
    await tx.put(
      id,
      channelRow(receipt, 'mutation', { fingerprint }, now, {
        expiresAt: now + CHANNEL_RETENTION_MS,
      }),
    );
    await tx.put(
      id,
      channelRow(
        `provider-block:${participantId}`,
        'asset',
        { participantId, desired, state: 'pending', actor, updatedAt: now, operationId },
        now,
      ),
    );
    return { address, generation: binding.generation, revision: operationId };
  });
}
export async function finishChannelProviderBlock(
  store: ChannelStore,
  id: string,
  participantId: string,
  revision: string,
  state: ChannelProviderBlock['state'],
  now: number,
  code?: string,
) {
  await store.transaction([id], async (tx) => {
    const key = `provider-block:${participantId}`;
    const prior = await channelValue<ChannelProviderBlock & { operationId: string }>(tx, id, key);
    if (!prior || prior.operationId !== revision || prior.state !== 'pending')
      throw new ChannelError('revision_conflict');
    await tx.put(
      id,
      channelRow(
        key,
        'asset',
        { ...prior, state, updatedAt: now, ...(code ? { code } : {}) },
        now,
        prior.desired === 'unblocked' && state === 'confirmed'
          ? { expiresAt: now + CHANNEL_RETENTION_MS }
          : {},
      ),
    );
  });
}
export async function channelProviderBlocks(
  store: ChannelStore,
  id: string,
  now: number,
  after?: string,
): Promise<ChannelProviderBlock[]> {
  return store.transaction([id], async (tx) => {
    await requireChannel(tx, id);
    return (
      await tx.list(id, {
        kind: 'asset',
        limit: 100,
        ...(after ? { after: `provider-block:${after}` } : {}),
      })
    )
      .filter((row) => row.id.startsWith('provider-block:'))
      .map((row) => {
        const record = row.value as ChannelProviderBlock;
        return record.state === 'pending' && now - record.updatedAt >= 30_000
          ? { ...record, state: 'unknown' as const, code: 'provider_outcome_unknown' }
          : record;
      });
  });
}

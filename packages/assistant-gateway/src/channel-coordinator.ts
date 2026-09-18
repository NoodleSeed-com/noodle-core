import { randomBytes, randomUUID } from 'node:crypto';
import { receiveChannelMessages } from './channel-inbox.js';
import { channelUsage, reserveChannelSpend, settleChannelSpend } from './channel-spend.js';
import type { ChannelStore, ChannelTransaction } from './channel-store.js';
import {
  CHANNEL_REGISTRY,
  CHANNEL_RETENTION_MS,
  type ChannelBinding,
  type ChannelConfigure,
  ChannelError,
  type ChannelEvent,
  type ChannelInbound,
  type ChannelLimitsInput,
  type ChannelParticipant,
  channelDigest,
  channelLimits,
  channelRow,
  channelTenantKey,
  channelValue,
  publicChannelBinding,
  writeChannelEvent,
} from './channel-types.js';
import {
  assertChannelSend,
  claimChannelTurn,
  completeChannelTurn,
  prepareChannelSend,
  renewChannelTurn,
  updateChannelSend,
} from './channel-work.js';
import type { TenantRef } from './tenant-ref.js';

export interface ChannelBlock {
  readonly participantId: string;
  readonly actor: string;
  readonly reason: 'operator';
  readonly until: number | null;
}
export async function requireChannel(tx: ChannelTransaction, id: string): Promise<ChannelBinding> {
  const binding = await channelValue<ChannelBinding>(tx, id, 'binding');
  if (!binding) throw new ChannelError('channel_not_found');
  return binding;
}
export async function channelBlocked(
  tx: ChannelTransaction,
  id: string,
  participant: string,
  now: number,
): Promise<boolean> {
  const block = await channelValue<ChannelBlock>(tx, id, `block:${participant}`);
  return !!block && (block.until === null || block.until > now);
}
export async function requireChannelLive(
  tx: ChannelTransaction,
  id: string,
): Promise<ChannelBinding> {
  const binding = await requireChannel(tx, id);
  if (binding.state !== 'enabled') throw new ChannelError('channel_paused');
  return binding;
}
async function mutation<T>(
  tx: ChannelTransaction,
  id: string,
  key: string,
  input: unknown,
  now: number,
  work: () => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200) throw new ChannelError('idempotency_key_invalid');
  const recordId = `mutation:${channelDigest(key)}`;
  const fingerprint = channelDigest(JSON.stringify(input));
  const old = await channelValue<{ fingerprint: string; result: T }>(tx, id, recordId);
  if (old) {
    if (old.fingerprint !== fingerprint) throw new ChannelError('idempotency_conflict');
    return old.result;
  }
  const result = await work();
  await tx.put(
    id,
    channelRow(recordId, 'mutation', { fingerprint, result }, now, {
      expiresAt: now + CHANNEL_RETENTION_MS,
    }),
  );
  return result;
}
/** Sole authority for channel state. HTTP adapters authenticate tenants before obtaining a binding id. */
export class ChannelCoordinator {
  constructor(
    readonly store: ChannelStore,
    readonly now: () => number = Date.now,
  ) {}
  async get(tenant: TenantRef) {
    const id = await this.store.transaction([CHANNEL_REGISTRY], (tx) =>
      channelValue<string>(tx, CHANNEL_REGISTRY, channelTenantKey(tenant)),
    );
    return id ? publicChannelBinding(await this.internal(id)) : undefined;
  }
  async internal(id: string): Promise<ChannelBinding> {
    return this.store.transaction([id], (tx) => requireChannel(tx, id));
  }
  async bindingPage(after?: string): Promise<{ ids: string[]; after?: string }> {
    return this.store.transaction([CHANNEL_REGISTRY], async (tx) => {
      const rows = await tx.list(CHANNEL_REGISTRY, {
        kind: 'binding',
        limit: 100,
        ...(after ? { after } : {}),
      });
      const last = rows.at(-1)?.id;
      return {
        ids: rows.map((row) => row.value as string),
        ...(rows.length === 100 && last ? { after: last } : {}),
      };
    });
  }
  async configure(input: ChannelConfigure, actor: string, key: string, revision: number) {
    const tenantKey = channelTenantKey(input.tenant);
    const priorId = await this.store.transaction([CHANNEL_REGISTRY], (tx) =>
      channelValue<string>(tx, CHANNEL_REGISTRY, tenantKey),
    );
    const prior = priorId ? await this.internal(priorId) : undefined;
    const sameAsset = prior?.phoneNumberId === input.phoneNumberId;
    const id = sameAsset ? prior.id : randomUUID();
    return this.store.transaction([CHANNEL_REGISTRY, id, ...(priorId ? [priorId] : [])], (tx) =>
      mutation(tx, id, key, { input, revision, actor }, this.now(), async () => {
        if ((await channelValue<string>(tx, CHANNEL_REGISTRY, tenantKey)) !== priorId)
          throw new ChannelError('revision_conflict');
        const existing = priorId
          ? await channelValue<ChannelBinding>(tx, priorId, 'binding')
          : undefined;
        if ((existing?.revision ?? 0) !== revision) throw new ChannelError('revision_conflict');
        if (existing && !sameAsset && existing.state !== 'disconnected')
          throw new ChannelError('asset_change_requires_disconnect');
        const assetKey = `asset:${channelDigest(input.phoneNumberId)}`;
        const owner = await channelValue<string>(tx, CHANNEL_REGISTRY, assetKey);
        if (owner && owner !== id) throw new ChannelError('asset_in_use');
        const now = this.now();
        const binding: ChannelBinding = {
          ...input,
          id,
          provider: '360dialog',
          revision: revision + 1,
          generation: (existing?.generation ?? 0) + 1,
          state: 'paused',
          indexKey: sameAsset ? prior.indexKey : randomBytes(32).toString('base64'),
          limits: channelLimits(input.limits ?? (sameAsset ? prior.limits : undefined)),
          actor,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await tx.put(CHANNEL_REGISTRY, channelRow(tenantKey, 'binding', id, now));
        await tx.put(CHANNEL_REGISTRY, channelRow(assetKey, 'asset', id, now));
        await tx.put(id, channelRow('binding', 'binding', binding, now));
        return publicChannelBinding(binding);
      }),
    );
  }
  async checkCredentials(id: string, digest: string): Promise<void> {
    const changed = await this.store.transaction([id], async (tx) => {
      const binding = await requireChannel(tx, id);
      if (binding.credentialDigest === digest) return false;
      const changed = binding.credentialDigest !== undefined;
      await tx.put(
        id,
        channelRow(
          'binding',
          'binding',
          {
            ...binding,
            credentialDigest: digest,
            ...(changed
              ? {
                  state: 'paused',
                  generation: binding.generation + 1,
                  revision: binding.revision + 1,
                  readyAt: undefined,
                  readyRevision: undefined,
                }
              : {}),
          },
          this.now(),
        ),
      );
      return changed;
    });
    if (changed) throw new ChannelError('credentials_changed');
  }
  async markReady(id: string, revision: number): Promise<void> {
    await this.store.transaction([id], async (tx) => {
      const binding = await requireChannel(tx, id);
      if (binding.revision !== revision) throw new ChannelError('revision_conflict');
      await tx.put(
        id,
        channelRow(
          'binding',
          'binding',
          { ...binding, readyAt: this.now(), readyRevision: revision },
          this.now(),
        ),
      );
    });
  }
  async setState(
    id: string,
    state: ChannelBinding['state'],
    actor: string,
    key: string,
    revision: number,
  ) {
    return this.store.transaction([CHANNEL_REGISTRY, id], (tx) =>
      mutation(tx, id, key, { state, actor, revision }, this.now(), async () => {
        const binding = await requireChannel(tx, id);
        if (binding.revision !== revision) throw new ChannelError('revision_conflict');
        if (
          state === 'enabled' &&
          (binding.readyRevision !== revision || this.now() - (binding.readyAt ?? 0) > 300_000)
        )
          throw new ChannelError('not_ready');
        if (
          state === 'enabled' &&
          (await channelValue<string>(
            tx,
            CHANNEL_REGISTRY,
            `asset:${channelDigest(binding.phoneNumberId)}`,
          )) !== id
        )
          throw new ChannelError('asset_not_owned');
        if (state === 'disconnected') {
          const assetKey = `asset:${channelDigest(binding.phoneNumberId)}`;
          if ((await channelValue<string>(tx, CHANNEL_REGISTRY, assetKey)) === id)
            await tx.remove(CHANNEL_REGISTRY, assetKey);
        }
        const updated: ChannelBinding = {
          ...binding,
          state,
          revision: revision + 1,
          generation: binding.generation + 1,
          actor,
          updatedAt: this.now(),
          readyAt: undefined,
          readyRevision: undefined,
        };
        await tx.put(id, channelRow('binding', 'binding', updated, this.now()));
        return publicChannelBinding(updated);
      }),
    );
  }
  async block(
    id: string,
    participantId: string,
    actor: string,
    key: string,
    until: number | null,
  ): Promise<void> {
    if (
      !/^p_[a-f0-9]{64}$/.test(participantId) ||
      (until !== null && (!Number.isSafeInteger(until) || until <= this.now()))
    )
      throw new ChannelError('block_invalid');
    await this.store.transaction([id], (tx) =>
      mutation(tx, id, key, { participantId, actor, until }, this.now(), async () => {
        await requireChannel(tx, id);
        const block: ChannelBlock = { participantId, actor, reason: 'operator', until };
        await tx.put(
          id,
          channelRow(
            `block:${participantId}`,
            'block',
            block,
            this.now(),
            until === null ? {} : { expiresAt: until + CHANNEL_RETENTION_MS },
          ),
        );
        return null;
      }),
    );
  }
  async unblock(id: string, participantId: string, actor: string, key: string): Promise<void> {
    await this.store.transaction([id], (tx) =>
      mutation(tx, id, key, { participantId, actor, action: 'unblock' }, this.now(), async () => {
        await requireChannel(tx, id);
        await tx.remove(id, `block:${participantId}`);
        return null;
      }),
    );
  }
  async blocks(id: string, after?: string): Promise<ChannelBlock[]> {
    return this.store.transaction([id], async (tx) => {
      await requireChannel(tx, id);
      return (
        await tx.list(id, {
          kind: 'block',
          limit: 100,
          ...(after ? { after: `block:${after}` } : {}),
        })
      ).map((row) => row.value as ChannelBlock);
    });
  }
  async events(id: string, after?: string): Promise<ChannelEvent[]> {
    return this.store.transaction([id], async (tx) => {
      await requireChannel(tx, id);
      return (await tx.list(id, { kind: 'event', limit: 100, ...(after ? { after } : {}) })).map(
        (row) => row.value as ChannelEvent,
      );
    });
  }
  async forget(id: string, participantId: string, actor: string, key: string): Promise<void> {
    await this.store.transaction([id], (tx) =>
      mutation(tx, id, key, { participantId, actor, action: 'forget' }, this.now(), async () => {
        await requireChannel(tx, id);
        await tx.remove(id, participantId);
        // Bounded pages retain minimal replay evidence but erase every message body and reply.
        let after: string | undefined;
        for (;;) {
          const rows = await tx.list(id, {
            kind: 'event',
            limit: 1000,
            ...(after ? { after } : {}),
          });
          for (const row of rows) {
            const event = row.value as ChannelEvent;
            if (event.participantId === participantId) {
              const { text: _text, reply: _reply, ...minimal } = event;
              await tx.put(id, {
                ...row,
                state: 'cancelled',
                value: { ...minimal, state: 'cancelled', code: 'forgotten' },
                updatedAt: this.now(),
              });
            }
          }
          if (rows.length < 1000) break;
          after = rows.at(-1)!.id;
        }
        return null;
      }),
    );
  }
  async updateLimits(
    id: string,
    input: ChannelLimitsInput,
    actor: string,
    key: string,
    revision: number,
  ) {
    return this.store.transaction([id], (tx) =>
      mutation(tx, id, key, { input, actor, revision }, this.now(), async () => {
        const binding = await requireChannel(tx, id);
        if (binding.revision !== revision) throw new ChannelError('revision_conflict');
        const next = {
          ...binding,
          limits: channelLimits({ ...binding.limits, ...input }),
          revision: revision + 1,
          actor,
          updatedAt: this.now(),
        };
        await tx.put(id, channelRow('binding', 'binding', next, this.now()));
        return publicChannelBinding(next);
      }),
    );
  }
  async cooldown(id: string, participantId: string) {
    return this.store.transaction([id], async (tx) => {
      await requireChannel(tx, id);
      const participant = await channelValue<ChannelParticipant>(tx, id, participantId);
      return {
        participantId,
        until:
          participant?.cooldownUntil && participant.cooldownUntil > this.now()
            ? participant.cooldownUntil
            : null,
      };
    });
  }
  async clearCooldown(
    id: string,
    participantId: string,
    actor: string,
    key: string,
  ): Promise<void> {
    await this.store.transaction([id], (tx) =>
      mutation(
        tx,
        id,
        key,
        { participantId, actor, action: 'clear-cooldown' },
        this.now(),
        async () => {
          await requireChannel(tx, id);
          const row = await tx.get(id, participantId);
          if (row) {
            const { cooldownUntil: _until, ...participant } = row.value as ChannelParticipant;
            await tx.put(id, {
              ...row,
              value: { ...participant, strikes: [] },
              updatedAt: this.now(),
            });
          }
          return null;
        },
      ),
    );
  }
  async expireHistory(id: string, retentionMs: number): Promise<void> {
    await this.store.transaction([id], async (tx) => {
      await requireChannel(tx, id);
      const now = this.now(),
        cutoff = now - Math.min(retentionMs, CHANNEL_RETENTION_MS);
      for (const kind of ['event', 'participant'] as const) {
        const key = `purge:${kind}`;
        const cursor = await channelValue<string>(tx, id, key);
        const rows = await tx.list(id, { kind, limit: 100, ...(cursor ? { after: cursor } : {}) });
        for (const row of rows) {
          if (kind === 'event') {
            const event = row.value as ChannelEvent;
            if (event.receivedAt > cutoff || (!event.text && !event.reply)) continue;
            const { text: _text, reply: _reply, ...minimal } = event;
            const state = ['queued', 'running', 'reply', 'sending'].includes(event.state)
              ? 'expired'
              : event.state;
            await tx.put(id, { ...row, state, value: { ...minimal, state }, updatedAt: now });
          } else {
            const person = row.value as ChannelParticipant;
            if (person.lastInboundAt <= cutoff) await tx.remove(id, row.id);
            else
              await tx.put(id, {
                ...row,
                value: { ...person, history: person.history.filter((item) => item.at > cutoff) },
                expiresAt: Math.min(row.expiresAt ?? Infinity, person.lastInboundAt + retentionMs),
              });
          }
        }
        const last = rows.at(-1)?.id;
        if (rows.length === 100 && last) await tx.put(id, channelRow(key, 'mutation', last, now));
        else await tx.remove(id, key);
      }
    });
  }
  async claimTool(id: string, participantId: string, name: string): Promise<boolean> {
    return this.store.transaction([id], async (tx) => {
      await requireChannelLive(tx, id);
      const row = await tx.get(id, participantId);
      if (!row) throw new ChannelError('context_expired');
      const participant = row.value as ChannelParticipant;
      if (participant.modelToolUses?.includes(name)) return false;
      await tx.put(id, {
        ...row,
        value: { ...participant, modelToolUses: [...(participant.modelToolUses ?? []), name] },
      });
      return true;
    });
  }
  async event(id: string, eventId: string): Promise<ChannelEvent | undefined> {
    return this.store.transaction([id], async (tx) => {
      await requireChannel(tx, id);
      return channelValue<ChannelEvent>(tx, id, eventId);
    });
  }
  async fail(id: string, eventId: string, lease: string, code: string): Promise<void> {
    await this.store.transaction([id], async (tx) => {
      const event = await channelValue<ChannelEvent>(tx, id, eventId);
      if (!event || event.lease !== lease || event.state !== 'running') return;
      await writeChannelEvent(tx, id, { ...event, state: 'failed', code }, this.now());
    });
  }
  receive(id: string, messages: readonly ChannelInbound[], retentionMs = CHANNEL_RETENTION_MS) {
    return receiveChannelMessages(this.store, id, messages, this.now(), retentionMs);
  }
  claim(id: string, retentionMs = CHANNEL_RETENTION_MS) {
    return claimChannelTurn(this.store, id, this.now(), retentionMs);
  }
  renew(id: string, eventId: string, lease: string) {
    return renewChannelTurn(this.store, id, eventId, lease, this.now());
  }
  complete(
    id: string,
    eventId: string,
    lease: string,
    reply: string,
    retentionMs = CHANNEL_RETENTION_MS,
    code?: string,
  ) {
    return completeChannelTurn(
      this.store,
      id,
      eventId,
      lease,
      reply,
      this.now(),
      retentionMs,
      code,
    );
  }
  assertSend(id: string, eventId: string, lease: string) {
    return assertChannelSend(this.store, id, eventId, lease, this.now());
  }
  prepareSend(id: string) {
    return prepareChannelSend(this.store, id, this.now());
  }
  sent(
    id: string,
    eventId: string,
    lease: string,
    result: { state: 'accepted' | 'unknown' | 'failed'; providerMessageId?: string; code?: string },
  ) {
    return updateChannelSend(this.store, id, eventId, lease, result, this.now());
  }
  reserveSpend(id: string, attempt: string, maximumMicroUsd: number) {
    return reserveChannelSpend(this.store, id, attempt, maximumMicroUsd, this.now());
  }
  settleSpend(id: string, attempt: string, actualMicroUsd: number) {
    return settleChannelSpend(this.store, id, attempt, actualMicroUsd, this.now());
  }
  usage(id: string) {
    return channelUsage(this.store, id, this.now());
  }
}

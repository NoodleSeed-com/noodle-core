import { describe, expect, it } from 'vitest';
import { ChannelCoordinator } from '../src/channel-coordinator.js';
import {
  beginChannelProviderBlock,
  channelProviderBlocks,
  finishChannelProviderBlock,
} from '../src/channel-provider-blocks.js';
import { InMemoryChannelStore } from '../src/channel-store.js';
import { recordChannelDelivery } from '../src/channel-work.js';

async function setup() {
  const now = 1_800_000_000_000;
  const channels = new ChannelCoordinator(new InMemoryChannelStore(), () => now);
  const binding = await channels.configure(
    {
      tenant: { org: 'org', app: 'site', env: 'prod' },
      phoneNumberId: 'asset',
      apiKeySecret: 'API_KEY',
      webhookSecret: 'CALLBACK_KEY',
      deploymentId: 'deploy',
      capabilities: [],
      supportEmail: 'help@example.test',
    },
    'operator',
    'configure',
    0,
  );
  await channels.markReady(binding.id, binding.revision);
  await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
  const [receipt] = await channels.receive(binding.id, [
    {
      providerId: 'inbound',
      address: { kind: 'phone', value: '15551112222' },
      text: 'Hi',
      eventAt: now,
    },
  ]);
  return { channels, binding, participantId: receipt!.participantId, now };
}
describe('provider evidence and local block separation', () => {
  it('joins early delivery receipts and never regresses read to delivered', async () => {
    const { channels, binding, now } = await setup();
    const work = (await channels.claim(binding.id))!;
    await channels.complete(binding.id, work.event.id, work.event.lease!, 'Hello');
    const send = (await channels.prepareSend(binding.id))!;
    await recordChannelDelivery(channels.store, binding.id, 'outbound', 'read', now);
    await channels.sent(binding.id, send.event.id, send.event.lease!, {
      state: 'accepted',
      providerMessageId: 'outbound',
    });
    await recordChannelDelivery(channels.store, binding.id, 'outbound', 'delivered', now);
    expect((await channels.event(binding.id, work.event.id))?.state).toBe('read');
  });
  it('never replays a provider mutation and supports explicit unblock after context erasure', async () => {
    const { channels, binding, participantId, now } = await setup();
    await channels.block(binding.id, participantId, 'operator', 'local', null);
    const operation = (await beginChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      'blocked',
      'operator',
      'provider',
      now,
    ))!;
    expect(
      await beginChannelProviderBlock(
        channels.store,
        binding.id,
        participantId,
        'blocked',
        'operator',
        'provider',
        now,
      ),
    ).toBeUndefined();
    await finishChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      operation.revision,
      'confirmed',
      now,
    );
    await channels.forget(binding.id, participantId, 'operator', 'forget');
    await expect(
      beginChannelProviderBlock(
        channels.store,
        binding.id,
        participantId,
        'unblocked',
        'operator',
        'unblock',
        now,
        '+15559999999',
      ),
    ).rejects.toMatchObject({ code: 'provider_recipient_unavailable' });
    const unblock = (await beginChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      'unblocked',
      'operator',
      'unblock',
      now,
      '+15551112222',
    ))!;
    await expect(
      finishChannelProviderBlock(
        channels.store,
        binding.id,
        participantId,
        operation.revision,
        'confirmed',
        now,
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict' });
    await finishChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      unblock.revision,
      'unknown',
      now,
    );
    expect((await channelProviderBlocks(channels.store, binding.id, now))[0]?.state).toBe(
      'unknown',
    );
    expect(await channels.blocks(binding.id)).toHaveLength(1);
    const retry = (await beginChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      'unblocked',
      'operator',
      'explicit-retry',
      now,
      '+15551112222',
    ))!;
    await finishChannelProviderBlock(
      channels.store,
      binding.id,
      participantId,
      retry.revision,
      'confirmed',
      now,
    );
    await expect(
      beginChannelProviderBlock(
        channels.store,
        binding.id,
        participantId,
        'unblocked',
        'operator',
        'new-unrelated-operation',
        now,
        '+15551112222',
      ),
    ).rejects.toMatchObject({ code: 'provider_block_not_owned' });
  });
});

import { describe, expect, it } from 'vitest';
import { ChannelCoordinator } from '../src/channel-coordinator.js';
import { InMemoryChannelStore } from '../src/channel-store.js';
import type { ChannelEvent } from '../src/channel-types.js';

const tenant = { org: 'org', app: 'site', env: 'production' };
const NOW = 1_800_000_000_000;
const address = { kind: 'phone' as const, value: '15551112222' };

/** Native reply buttons (ADR 0240): a tap is conversation input, never media to bounce. */
describe('channel reply buttons', () => {
  async function setup() {
    const store = new InMemoryChannelStore();
    const channels = new ChannelCoordinator(store, () => NOW);
    const binding = await channels.configure(
      {
        tenant,
        phoneNumberId: 'phone-1',
        apiKeySecret: 'WHATSAPP_API_KEY',
        webhookSecret: 'WHATSAPP_WEBHOOK_SECRET',
        deploymentId: 'deploy-1',
        capabilities: [],
        supportEmail: 'hello@example.com',
      },
      'operator',
      'create',
      0,
    );
    await channels.markReady(binding.id, binding.revision);
    await channels.setState(binding.id, 'enabled', 'operator', 'enable', binding.revision);
    const row = <T>(id: string) =>
      store.transaction([binding.id], async (tx) => (await tx.get(binding.id, id))?.value as T);
    return { channels, binding, row };
  }

  it('queues a tapped button as work with its id and no text, while media still gets the text request', async () => {
    const { channels, binding, row } = await setup();
    const receipts = await channels.receive(binding.id, [
      { providerId: 'tap-1', address, eventAt: NOW, button: { id: 'b_1', title: 'Confirm' } },
      { providerId: 'image-1', address, eventAt: NOW },
    ]);
    expect(receipts.map((receipt) => receipt.state)).toEqual(['queued', 'reply']);
    const tapped = await row<ChannelEvent>(receipts[0]!.id);
    expect(tapped.button).toEqual({ id: 'b_1', title: 'Confirm' });
    expect(tapped).not.toHaveProperty('text');
    const bounced = await row<ChannelEvent>(receipts[1]!.id);
    expect(bounced.reply).toContain('Please send a text message');
  });

  it('lets the worker close a tap it cannot bind as cancelled with a content-free code', async () => {
    const { channels, binding, row } = await setup();
    await channels.receive(binding.id, [
      { providerId: 'tap-2', address, eventAt: NOW, button: { id: 'b_stale', title: 'Confirm' } },
    ]);
    const turn = await channels.claim(binding.id);
    if (turn === undefined) throw new Error('claim');
    await channels.fail(
      binding.id,
      turn.event.id,
      turn.event.lease ?? '',
      'button_unbound',
      'cancelled',
    );
    const closed = await row<ChannelEvent>(turn.event.id);
    expect(closed).toMatchObject({ state: 'cancelled', code: 'button_unbound' });
    expect(await channels.prepareSend(binding.id)).toBeUndefined();
  });

  it('carries review buttons on the reply until dispatch is attempted, then drops them', async () => {
    const { channels, binding, row } = await setup();
    await channels.receive(binding.id, [
      { providerId: 'text-1', address, eventAt: NOW, text: 'yes' },
    ]);
    const turn = await channels.claim(binding.id);
    if (turn === undefined) throw new Error('claim');
    const buttons = [
      { id: 'b_confirm', title: 'Confirm' },
      { id: 'b_edit', title: 'Edit' },
      { id: 'b_cancel', title: 'Cancel' },
    ];
    await channels.complete(
      binding.id,
      turn.event.id,
      turn.event.lease ?? '',
      'Your name: Maya\n\nShall I send it?',
      undefined,
      undefined,
      undefined,
      buttons,
    );
    const send = await channels.prepareSend(binding.id);
    if (send === undefined) throw new Error('send');
    expect(send.event.buttons).toEqual(buttons);
    await channels.sent(binding.id, send.event.id, send.event.lease ?? '', {
      state: 'accepted',
      providerMessageId: 'wamid.buttons',
    });
    const dispatched = await row<ChannelEvent>(turn.event.id);
    expect(dispatched.state).toBe('accepted');
    expect(dispatched).not.toHaveProperty('buttons');
  });
});

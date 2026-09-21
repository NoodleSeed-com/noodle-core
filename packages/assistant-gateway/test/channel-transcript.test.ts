import { describe, expect, it } from 'vitest';
import { ChannelCoordinator } from '../src/channel-coordinator.js';
import { InMemoryChannelStore } from '../src/channel-store.js';
import type { ChannelEvent, ChannelParticipant } from '../src/channel-types.js';

const tenant = { org: 'org', app: 'site', env: 'production' };
const PRIVATE = 'maya@example.com';

/**
 * A turn may keep a different text in the transcript than it received or sent (ADR 0240: marked
 * private values never enter history). The sent reply survives only until dispatch is attempted.
 */
describe('channel transcript overrides', () => {
  async function setup() {
    const store = new InMemoryChannelStore();
    let now = 1_800_000_000_000;
    const channels = new ChannelCoordinator(store, () => now);
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
    await channels.receive(binding.id, [
      {
        providerId: 'message-1',
        address: { kind: 'phone', value: '15551112222' },
        eventAt: now,
        text: `I'm Maya, ${PRIVATE}`,
      },
    ]);
    const turn = await channels.claim(binding.id);
    if (turn === undefined) throw new Error('claim');
    const row = <T>(id: string) =>
      store.transaction([binding.id], async (tx) => (await tx.get(binding.id, id))?.value as T);
    return {
      channels,
      binding,
      turn,
      row,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('keeps redacted text in history and the event while sending the full reply, then scrubs the row', async () => {
    const { channels, binding, turn, row } = await setup();
    const review = `Work email: ${PRIVATE}\n\nShall I send it?`;
    await channels.complete(
      binding.id,
      turn.event.id,
      turn.event.lease ?? '',
      review,
      undefined,
      undefined,
      { user: "I'm Maya, [Work email withheld]", assistant: 'Work email: [Work email withheld]' },
    );
    const participant = await row<ChannelParticipant>(turn.participant.id);
    expect(participant.history.map((entry) => entry.content)).toEqual([
      "I'm Maya, [Work email withheld]",
      'Work email: [Work email withheld]',
    ]);
    const completed = await row<ChannelEvent>(turn.event.id);
    expect(completed.text).toBe("I'm Maya, [Work email withheld]");
    expect(completed.reply).toBe(review);
    expect(completed.replyTranscript).toBe('Work email: [Work email withheld]');

    const send = await channels.prepareSend(binding.id);
    if (send === undefined) throw new Error('send');
    expect(send.event.reply).toBe(review);
    await channels.sent(binding.id, send.event.id, send.event.lease ?? '', {
      state: 'accepted',
      providerMessageId: 'wamid.1',
    });
    const dispatched = await row<ChannelEvent>(turn.event.id);
    expect(dispatched.state).toBe('accepted');
    expect(dispatched.reply).toBe('Work email: [Work email withheld]');
    expect(dispatched).not.toHaveProperty('replyTranscript');
    expect(JSON.stringify(dispatched)).not.toContain(PRIVATE);
  });

  it('changes nothing about an ordinary turn without overrides', async () => {
    const { channels, binding, turn, row } = await setup();
    await channels.complete(binding.id, turn.event.id, turn.event.lease ?? '', 'Hello Maya');
    const participant = await row<ChannelParticipant>(turn.participant.id);
    expect(participant.history.map((entry) => entry.content)).toEqual([
      `I'm Maya, ${PRIVATE}`,
      'Hello Maya',
    ]);
    const completed = await row<ChannelEvent>(turn.event.id);
    expect(completed.text).toBe(`I'm Maya, ${PRIVATE}`);
    expect(completed).not.toHaveProperty('replyTranscript');
    const send = await channels.prepareSend(binding.id);
    if (send === undefined) throw new Error('send');
    await channels.sent(binding.id, send.event.id, send.event.lease ?? '', {
      state: 'accepted',
      providerMessageId: 'wamid.2',
    });
    expect((await row<ChannelEvent>(turn.event.id)).reply).toBe('Hello Maya');
  });
});

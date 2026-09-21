import { describe, expect, it, vi } from 'vitest';
import {
  Dialog360,
  parseWhatsAppWebhook,
  verifyWhatsAppWebhookSecret,
} from '../src/channels/360dialog.js';

const callback = (messages: unknown[], statuses: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'owned' },
            messages,
            statuses,
          },
        },
      ],
    },
  ],
});
describe('360dialog adapter', () => {
  it.each([
    ['AVAILABLE', true],
    ['LIMITED', true],
    ['BLOCKED', false],
  ])('preserves documented health status %s and whether messaging is permitted', async (status, canSend) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'owned', health_status: { can_send_message: status } }),
      );
    expect(await new Dialog360('private', fetcher).health()).toEqual({
      phoneNumberId: 'owned',
      canSend,
      status,
    });
  });
  it.each(['UNKNOWN', '', null])('refuses unrecognized provider health %s', async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ id: 'owned', health_status: { can_send_message: status } }),
      );
    await expect(new Dialog360('private', fetcher).health()).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });
  });
  it('normalizes the entire batch, distinguishes statuses and rejects a different asset', () => {
    const data = callback(
      [
        {
          id: 'one',
          from: '15551234567',
          timestamp: '1800000000',
          type: 'text',
          text: { body: 'Hello' },
        },
        {
          id: 'two',
          from: '15551234567',
          timestamp: '1800000001',
          type: 'image',
          image: { id: 'attachment' },
        },
      ],
      [{ id: 'reply', status: 'read', timestamp: '1800000002' }],
    );
    const parsed = parseWhatsAppWebhook(data, 'owned');
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]?.text).toBe('Hello');
    expect(parsed.messages[1]?.text).toBeUndefined();
    expect(parsed.statuses[0]?.state).toBe('read');
    expect(() => parseWhatsAppWebhook(data, 'someone-else')).toThrow('asset_mismatch');
  });
  it('normalizes a tapped reply button, ignores other interactive kinds and bounds the button id', () => {
    const tap = (id: string) => ({
      id: 'tap',
      from: '15551234567',
      timestamp: '1800000003',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id, title: 'Confirm' } },
    });
    const parsed = parseWhatsAppWebhook(
      callback([
        tap('b_opaque'),
        {
          id: 'list',
          from: '15551234567',
          timestamp: '1800000004',
          type: 'interactive',
          interactive: { type: 'list_reply', list_reply: { id: 'row', title: 'Row' } },
        },
      ]),
      'owned',
    );
    expect(parsed.messages[0]).toMatchObject({ button: { id: 'b_opaque', title: 'Confirm' } });
    expect(parsed.messages[0]?.text).toBeUndefined();
    expect(parsed.messages[1]?.button).toBeUndefined();
    expect(parsed.messages[1]?.text).toBeUndefined();
    expect(() => parseWhatsAppWebhook(callback([tap('x'.repeat(257))]), 'owned')).toThrow(
      'webhook_invalid',
    );
  });
  it('authenticates an independent callback secret and rejects malformed or duplicate headers', () => {
    expect(verifyWhatsAppWebhookSecret('x'.repeat(32), 'x'.repeat(32))).toBe(true);
    expect(verifyWhatsAppWebhookSecret(['x'.repeat(32)], 'x'.repeat(32))).toBe(false);
    expect(verifyWhatsAppWebhookSecret('wrong', 'x'.repeat(32))).toBe(false);
  });
  it('sends once and never retries an ambiguous timeout', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('socket closed'));
    const adapter = new Dialog360('secret-key', fetcher);
    const result = await adapter.send({
      to: { kind: 'phone', value: '15551234567' },
      text: 'Hello',
    });
    expect(result.state).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://waba-v2.360dialog.io/messages');
    expect(JSON.parse(init!.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
    });
  });
  it('sends the review as reply buttons and falls back to plain text only for a rejected payload', async () => {
    const to = { kind: 'phone' as const, value: '15551234567' };
    const buttons = [
      { id: 'b_confirm', title: 'Confirm' },
      { id: 'b_edit', title: 'Edit' },
      { id: 'b_cancel', title: 'Cancel' },
    ];
    const accepted = () => Response.json({ messages: [{ id: 'wamid.buttons' }] });
    const body = (call: number) =>
      JSON.parse(fetcher.mock.calls[call]![1]!.body as string) as Record<string, unknown>;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(accepted());
    const adapter = new Dialog360('secret-key', fetcher);
    const review = 'Your name: Maya Chen\n\nShall I send it?';
    expect(await adapter.send({ to, text: review, buttons })).toEqual({
      state: 'accepted',
      providerMessageId: 'wamid.buttons',
    });
    expect(body(0)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551234567',
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: review },
        action: { buttons: buttons.map((button) => ({ type: 'reply', reply: button })) },
      },
    });

    fetcher.mockReset();
    fetcher
      .mockResolvedValueOnce(new Response('{"error":"unsupported"}', { status: 400 }))
      .mockResolvedValueOnce(accepted());
    expect(await adapter.send({ to, text: review, buttons })).toEqual({
      state: 'accepted',
      providerMessageId: 'wamid.buttons',
      code: 'interactive_rejected',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(body(1)).toMatchObject({ type: 'text', text: { body: review } });

    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect((await adapter.send({ to, text: review, buttons })).state).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(new Response('', { status: 429 }));
    expect((await adapter.send({ to, text: review, buttons })).state).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockReset();
    fetcher.mockResolvedValueOnce(accepted());
    await adapter.send({ to, text: 'x'.repeat(1025), buttons });
    expect(body(0).type).toBe('text');
  });
  it('validates provider acceptance rather than treating any 2xx as delivery', async () => {
    const adapter = new Dialog360(
      'secret-key',
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ messages: [{ id: 'wamid.receipt' }] })),
    );
    expect(
      await adapter.send({
        to: { kind: 'phone', value: '15551234567' },
        text: 'Hi',
      }),
    ).toEqual({ state: 'accepted', providerMessageId: 'wamid.receipt' });
  });
  it('checks per-contact block receipts and keeps ambiguous provider outcomes explicit', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          block_users: { added_users: [{ input: '15551234567', wa_id: '15551234567' }] },
        }),
      )
      .mockResolvedValueOnce(Response.json({ block_users: { removed_users: [] } }));
    const provider = new Dialog360('private', fetcher);
    expect(await provider.setBlocked('15551234567', true)).toEqual({ state: 'confirmed' });
    expect((await provider.setBlocked('15551234567', false)).state).toBe('unknown');
    expect(fetcher.mock.calls.map(([, init]) => init?.method)).toEqual(['POST', 'DELETE']);
  });
});

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

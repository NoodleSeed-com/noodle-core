import { describe, expect, it, vi } from 'vitest';
import { parseWhatsAppWebhook } from '../src/channels/360dialog.js';
import { MetaCloud } from '../src/channels/meta-cloud.js';

const app = { appId: '931692592882983', graphVersion: 'v25.0' };
const asset = { phoneNumberId: '1040350119157691', wabaId: '2120347998801839' };
const graph = 'https://graph.facebook.com/v25.0';
const to = { kind: 'phone' as const, value: '15551234567' };
function adapter(fetcher: typeof fetch) {
  return new MetaCloud('business-token', asset, app, fetcher);
}
function call(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
  const [url, init] = fetcher.mock.calls[index]!;
  return {
    url: String(url),
    method: init?.method,
    authorization: new Headers(init?.headers).get('authorization'),
    redirect: init?.redirect,
    body:
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined,
  };
}
describe('Meta Cloud API adapter', () => {
  it.each([
    ['AVAILABLE', true],
    ['LIMITED', true],
    ['BLOCKED', false],
  ])('reads health %s from the phone-number node with the business token', async (status, canSend) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: asset.phoneNumberId,
        health_status: { can_send_message: status, entities: [] },
      }),
    );
    expect(await adapter(fetcher).health()).toEqual({
      phoneNumberId: asset.phoneNumberId,
      canSend,
      status,
    });
    expect(call(fetcher, 0)).toMatchObject({
      url: `${graph}/${asset.phoneNumberId}?fields=id,health_status`,
      method: 'GET',
      authorization: 'Bearer business-token',
      redirect: 'manual',
    });
  });
  it('refuses unrecognized health and an unavailable Graph API', async () => {
    const unknown = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ id: 'x', health_status: { can_send_message: 'MAYBE' } }));
    await expect(adapter(unknown).health()).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }));
    await expect(adapter(denied).health()).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
  it('refuses identifiers that are not Graph node ids before any request', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const bad = new MetaCloud('token', { ...asset, phoneNumberId: '../me' }, app, fetcher);
    await expect(bad.health()).rejects.toMatchObject({ code: 'provider_asset_invalid' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      () => new MetaCloud('token', asset, { ...app, graphVersion: 'latest' }, fetcher),
    ).toThrow('provider_configuration_invalid');
  });
  it('sends the same Cloud API body to the phone-number messages edge and never retries ambiguity', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ messages: [{ id: 'wamid.meta' }] }))
      .mockRejectedValueOnce(new Error('socket closed'));
    const meta = adapter(fetcher);
    expect(await meta.send({ to, text: 'Hello' })).toEqual({
      state: 'accepted',
      providerMessageId: 'wamid.meta',
    });
    expect(call(fetcher, 0)).toMatchObject({
      url: `${graph}/${asset.phoneNumberId}/messages`,
      method: 'POST',
      authorization: 'Bearer business-token',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: '15551234567',
        type: 'text',
        text: { body: 'Hello', preview_url: false },
      },
    });
    expect((await meta.send({ to, text: 'Hello' })).state).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('sends reply buttons and falls back to text only when Meta rejects the payload', async () => {
    const buttons = [{ id: 'b_confirm', title: 'Confirm' }];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":{"code":131009}}', { status: 400 }))
      .mockResolvedValueOnce(Response.json({ messages: [{ id: 'wamid.text' }] }));
    expect(await adapter(fetcher).send({ to, text: 'Shall I send it?', buttons })).toEqual({
      state: 'accepted',
      providerMessageId: 'wamid.text',
      code: 'interactive_rejected',
    });
    expect(call(fetcher, 0).body).toMatchObject({ type: 'interactive' });
    expect(call(fetcher, 1).body).toMatchObject({ type: 'text' });
  });
  it('addresses a business-scoped user id through the recipient field', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ messages: [{ id: 'wamid.bsuid' }] }));
    await adapter(fetcher).send({
      to: { kind: 'opaque', value: 'US.13491208655302741918' },
      text: 'Hi',
    });
    expect(call(fetcher, 0).body).toMatchObject({ recipient: 'US.13491208655302741918' });
    expect(call(fetcher, 0).body).not.toHaveProperty('to');
  });
  it('reads a username sender from from_user_id when Meta omits the phone number', () => {
    const inbound = (message: Record<string, unknown>) => ({
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: asset.phoneNumberId },
                messages: [{ id: 'wamid.1', timestamp: '1800000000', type: 'text', ...message }],
              },
            },
          ],
        },
      ],
    });
    expect(
      parseWhatsAppWebhook(
        inbound({ from_user_id: 'US.13491208655302741918' }),
        asset.phoneNumberId,
      ).messages[0]?.address,
    ).toEqual({ kind: 'opaque', value: 'US.13491208655302741918' });
    expect(
      parseWhatsAppWebhook(
        inbound({ from: '15551234567', from_user_id: 'US.13491208655302741918' }),
        asset.phoneNumberId,
      ).messages[0]?.address,
    ).toEqual({ kind: 'phone', value: '15551234567' });
  });
  it('blocks and unblocks on the phone-number block_users edge with per-contact receipts', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          block_users: { added_users: [{ input: '15551234567', wa_id: '15551234567' }] },
        }),
      )
      .mockResolvedValueOnce(Response.json({ block_users: { removed_users: [] } }));
    const meta = adapter(fetcher);
    expect(await meta.setBlocked('15551234567', true)).toEqual({ state: 'confirmed' });
    expect((await meta.setBlocked('15551234567', false)).state).toBe('unknown');
    expect([call(fetcher, 0), call(fetcher, 1)]).toMatchObject([
      { url: `${graph}/${asset.phoneNumberId}/block_users`, method: 'POST' },
      { url: `${graph}/${asset.phoneNumberId}/block_users`, method: 'DELETE' },
    ]);
  });
  it('inspects and subscribes the WABA to this Meta app without duplicating a subscription', async () => {
    const subscribed = Response.json({
      data: [{ whatsapp_business_api_data: { id: app.appId, name: 'Noodle Seed' } }],
    });
    const other = () =>
      Response.json({ data: [{ whatsapp_business_api_data: { id: '111', name: 'Other' } }] });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(other())
      .mockResolvedValueOnce(other())
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(subscribed);
    const meta = adapter(fetcher);
    const url = 'https://service.example/v1/channels/whatsapp/meta';
    expect(await meta.inspectWebhook(url)).toEqual({ matches: false, authenticated: true });
    await meta.configureWebhook(url);
    expect(call(fetcher, 2)).toMatchObject({
      url: `${graph}/${asset.wabaId}/subscribed_apps`,
      method: 'POST',
      authorization: 'Bearer business-token',
    });
    await meta.configureWebhook(url);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('reports a failed subscription instead of assuming success', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(Response.json({ success: false }));
    await expect(
      adapter(fetcher).configureWebhook('https://service.example/v1/channels/whatsapp/meta'),
    ).rejects.toMatchObject({ code: 'webhook_configuration_failed' });
  });
});

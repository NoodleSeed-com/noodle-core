import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ChannelError, recordChannelDelivery } from '@noodle-borg/assistant-gateway/portable';
import { readBodyBuffer, sendJson } from '@noodle-borg/transport-http';
import { z } from 'zod';
import { parseWhatsAppWebhook } from '../channels/360dialog.js';
import type { WhatsAppRuntime } from '../channels/runtime.js';

/**
 * Meta webhook endpoint contract, read 2026-09-22
 * (https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint):
 * the GET handshake carries `hub.mode=subscribe`, `hub.challenge` and `hub.verify_token`, and a valid
 * one is answered 200 with the challenge; every POST carries `X-Hub-Signature-256: sha256=<hex>`, an
 * HMAC-SHA256 of the payload keyed by the app secret. Anything but 200 is retried for up to seven
 * days (https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks), so after a
 * valid signature only a retryable failure answers otherwise.
 */
const SIGNATURE_HEADER = 'x-hub-signature-256';
const RETRYABLE = new Set([
  'ingress_capacity',
  'channel_unavailable',
  'history_policy_unavailable',
]);
const envelope = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        id: z.string().max(64),
        changes: z.array(z.object({ field: z.string().max(128), value: z.unknown() })).max(100),
      }),
    )
    .max(100),
});
const routed = z.object({ metadata: z.object({ phone_number_id: z.string().min(1).max(512) }) });
function same(actual: string, expected: string): boolean {
  const left = Buffer.from(actual),
    right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifyMetaSignature(raw: Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const actual = Buffer.from(header.slice(7), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function handshake(res: ServerResponse, url: URL, verifyToken: string): void {
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  if (
    url.searchParams.get('hub.mode') !== 'subscribe' ||
    token === null ||
    challenge === null ||
    !/^[\x21-\x7e]{1,1024}$/.test(challenge) ||
    !same(token, verifyToken)
  ) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(challenge);
}
export async function metaWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  runtime: WhatsAppRuntime,
): Promise<void> {
  const meta = runtime.options.meta;
  if (!meta) return sendJson(res, 404, { error: 'not_found' });
  if (req.method === 'GET') return handshake(res, url, meta.verifyToken);
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  const body = await readBodyBuffer(req, 1 << 20);
  if (!body.ok) return sendJson(res, 413, { error: 'webhook_invalid' });
  // The signature covers the exact bytes Meta sent; nothing is parsed before it verifies.
  if (!verifyMetaSignature(body.buffer, req.headers[SIGNATURE_HEADER], meta.appSecret))
    return sendJson(res, 401, { error: 'unauthorized' });
  // Content-free: a code and never a header, body, phone number or asset id.
  const skip = (code: string) =>
    runtime.deps.logger?.warn('assistant.channel.webhook', { provider: 'meta', code });
  let parsed: z.infer<typeof envelope> | undefined;
  try {
    const result = envelope.safeParse(JSON.parse(body.buffer.toString('utf8')));
    if (result.success) parsed = result.data;
  } catch {
    parsed = undefined;
  }
  if (!parsed) {
    skip('webhook_invalid');
    return sendJson(res, 200, { ok: true });
  }
  const groups = new Map<
    string,
    Array<{ waba: string; change: { field: string; value: unknown } }>
  >();
  let count = 0;
  for (const entry of parsed.entry)
    for (const change of entry.changes) {
      // System notifications carry no phone number and take no part in conversations.
      if (++count > 100 || change.field !== 'messages') continue;
      const target = routed.safeParse(change.value);
      if (!target.success) {
        skip('webhook_invalid');
        continue;
      }
      const phone = target.data.metadata.phone_number_id;
      groups.set(phone, [...(groups.get(phone) ?? []), { waba: entry.id, change }]);
    }
  if (count > 100) skip('batch_too_large');
  for (const [phoneNumberId, group] of groups) {
    try {
      const id = await runtime.channels.bindingForAsset(phoneNumberId);
      if (!id) throw new ChannelError('binding_unknown');
      const binding = await runtime.channels.internal(id);
      if (binding.provider !== 'meta') throw new ChannelError('provider_mismatch');
      // Defense in depth: the number must arrive under the WABA the operator bound it to.
      const changes = group.filter((item) => item.waba === binding.wabaId);
      if (changes.length !== group.length) skip('waba_mismatch');
      if (changes.length === 0) continue;
      const batch = parseWhatsAppWebhook(
        { object: parsed.object, entry: [{ changes: changes.map((item) => item.change) }] },
        phoneNumberId,
      );
      await runtime.channels.receive(id, batch.messages, await runtime.retention(binding));
      for (const status of batch.statuses)
        await recordChannelDelivery(
          runtime.channels.store,
          id,
          status.providerMessageId,
          status.state,
          runtime.channels.now(),
        );
    } catch (error) {
      if (!(error instanceof ChannelError) || RETRYABLE.has(error.code)) throw error;
      skip(error.code);
    }
  }
  sendJson(res, 200, { ok: true });
  runtime.options.worker.wake();
}

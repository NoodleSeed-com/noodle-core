import { timingSafeEqual } from 'node:crypto';
import {
  type ChannelAddress,
  ChannelError,
  type ChannelInbound,
} from '@noodle-borg/assistant-gateway/portable';
import { guardedFetch } from '@noodle-borg/connector-http';
import { z } from 'zod';

export const WHATSAPP_CALLBACK_HEADER = 'x-noodle-webhook-secret';
const identifier = z.string().min(1).max(512);
const timestamp = z
  .string()
  .regex(/^\d{1,13}$/)
  .transform((value) => Number(value) * 1000)
  .refine(Number.isSafeInteger);
const valueSchema = z.object({
  messaging_product: z.literal('whatsapp'),
  metadata: z.object({ phone_number_id: identifier }),
  messages: z
    .array(
      z.object({
        id: identifier,
        from: z.string().max(128).optional(),
        user_id: z.string().max(128).optional(),
        timestamp,
        type: z.string().max(64),
        text: z.object({ body: z.string().max(1 << 20) }).optional(),
      }),
    )
    .max(100)
    .optional(),
  statuses: z
    .array(
      z.object({
        id: identifier,
        status: z.enum(['sent', 'delivered', 'read', 'failed']),
        timestamp,
      }),
    )
    .max(100)
    .optional(),
});
const webhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z
    .array(
      z.object({
        changes: z.array(z.object({ field: z.string().max(128), value: z.unknown() })).max(100),
      }),
    )
    .max(100),
});
export function verifyWhatsAppWebhookSecret(input: unknown, secret: string): boolean {
  if (typeof input !== 'string' || secret.length < 32 || secret.length > 512) return false;
  const actual = Buffer.from(input),
    expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function parseWhatsAppWebhook(input: unknown, phoneNumberId: string) {
  const parsed = webhookSchema.safeParse(input);
  if (!parsed.success) throw new ChannelError('webhook_invalid');
  const messages: ChannelInbound[] = [];
  const statuses: Array<{
    providerMessageId: string;
    state: 'sent' | 'delivered' | 'read' | 'failed';
  }> = [];
  let count = 0;
  for (const entry of parsed.data.entry)
    for (const change of entry.changes) {
      if (++count > 100) throw new ChannelError('batch_too_large');
      // System notifications do not participate in conversation processing.
      if (change.field !== 'messages') continue;
      const validated = valueSchema.safeParse(change.value);
      if (!validated.success) throw new ChannelError('webhook_invalid');
      const value = validated.data;
      if (value.metadata.phone_number_id !== phoneNumberId)
        throw new ChannelError('asset_mismatch');
      for (const message of value.messages ?? []) {
        let address: ChannelAddress;
        if (message.from && /^[1-9]\d{5,14}$/.test(message.from))
          address = { kind: 'phone', value: message.from };
        else if (message.user_id && /^[A-Z]{2}\.[A-Za-z0-9]{1,124}$/.test(message.user_id))
          address = { kind: 'opaque', value: message.user_id };
        else throw new ChannelError('recipient_invalid');
        messages.push({
          providerId: message.id,
          address,
          eventAt: message.timestamp,
          ...(message.type === 'text' && message.text ? { text: message.text.body } : {}),
        });
      }
      for (const status of value.statuses ?? [])
        statuses.push({ providerMessageId: status.id, state: status.status });
      if (messages.length + statuses.length > 100) throw new ChannelError('batch_too_large');
    }
  return { messages, statuses };
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ChannelError('provider_response_invalid');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 65_536) throw new ChannelError('provider_response_invalid');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export class Dialog360 {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = (url, init) => guardedFetch(new URL(url), init),
  ) {}
  private async request(path: string, method = 'GET', body?: unknown): Promise<Response> {
    return this.fetcher(`https://waba-v2.360dialog.io${path}`, {
      method,
      headers: { 'D360-API-KEY': this.apiKey, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  }
  async health() {
    const response = await this.request('/health_status?fields=id');
    if (!response.ok) throw new ChannelError('provider_unavailable');
    const parsed = z
      .object({ id: identifier, health_status: z.object({ can_send_message: z.string() }) })
      .safeParse(await boundedJson(response));
    if (!parsed.success) throw new ChannelError('provider_response_invalid');
    return {
      phoneNumberId: parsed.data.id,
      canSend: parsed.data.health_status.can_send_message === 'AVAILABLE',
    };
  }
  async webhook() {
    const response = await this.request('/v1/configs/webhook');
    if (!response.ok) throw new ChannelError('provider_unavailable');
    const parsed = z
      .object({ url: z.string().max(2048), headers: z.record(z.string(), z.string()).optional() })
      .safeParse(await boundedJson(response));
    if (!parsed.success) throw new ChannelError('provider_response_invalid');
    return parsed.data;
  }
  async configureWebhook(url: string, secret: string): Promise<void> {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.username ||
      target.password ||
      target.port ||
      target.hash ||
      target.search
    )
      throw new ChannelError('webhook_url_invalid');
    if (!verifyWhatsAppWebhookSecret(secret, secret))
      throw new ChannelError('webhook_secret_invalid');
    const response = await this.request('/v1/configs/webhook', 'POST', {
      url,
      headers: { [WHATSAPP_CALLBACK_HEADER]: secret },
    });
    if (!response.ok) throw new ChannelError('webhook_configuration_failed');
    await response.body?.cancel();
  }
  async setBlocked(
    phone: string,
    blocked: boolean,
  ): Promise<{ state: 'confirmed' | 'error' | 'unknown'; code?: string }> {
    try {
      const response = await this.request('/block_users', blocked ? 'POST' : 'DELETE', {
        messaging_product: 'whatsapp',
        block_users: [{ user: phone }],
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          state: response.status >= 500 ? 'unknown' : 'error',
          code: `provider_http_${response.status}`,
        };
      }
      const field = blocked ? 'added_users' : 'removed_users';
      const parsed = z
        .object({
          block_users: z.object({
            [field]: z.array(z.object({ input: z.string(), wa_id: z.string() })),
          }),
        })
        .safeParse(await boundedJson(response));
      return parsed.success &&
        parsed.data.block_users[field]?.some((user) => user.input === phone || user.wa_id === phone)
        ? { state: 'confirmed' }
        : { state: 'unknown', code: 'provider_receipt_invalid' };
    } catch {
      return { state: 'unknown', code: 'provider_outcome_unknown' };
    }
  }
  async send(input: { readonly to: ChannelAddress; readonly text: string }): Promise<{
    state: 'accepted' | 'failed' | 'unknown';
    providerMessageId?: string;
    code?: string;
  }> {
    if (!input.text || input.text.length > 4096) return { state: 'failed', code: 'reply_invalid' };
    try {
      const response = await this.request('/messages', 'POST', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        type: 'text',
        ...(input.to.kind === 'phone' ? { to: input.to.value } : { recipient: input.to.value }),
        text: { body: input.text, preview_url: false },
      });
      if (!response.ok) {
        await response.body?.cancel();
        return {
          state: response.status >= 500 || response.status === 408 ? 'unknown' : 'failed',
          code: `provider_http_${response.status}`,
        };
      }
      const parsed = z
        .object({ messages: z.array(z.object({ id: identifier })).length(1) })
        .safeParse(await boundedJson(response));
      return parsed.success
        ? { state: 'accepted', providerMessageId: parsed.data.messages[0]!.id }
        : { state: 'unknown', code: 'provider_receipt_invalid' };
    } catch {
      return { state: 'unknown', code: 'send_outcome_unknown' };
    }
  }
}

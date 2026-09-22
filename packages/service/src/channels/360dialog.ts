import { timingSafeEqual } from 'node:crypto';
import {
  type ChannelAddress,
  ChannelError,
  type ChannelInbound,
} from '@noodle-borg/assistant-gateway/portable';
import { guardedFetch } from '@noodle-borg/connector-http';
import { z } from 'zod';
import {
  boundedJson,
  cloudApiHealth,
  cloudApiSend,
  cloudApiSetBlocked,
  type WhatsAppBlockResult,
  type WhatsAppHealth,
  type WhatsAppProvider,
  type WhatsAppSendInput,
  type WhatsAppSendResult,
} from './provider.js';

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
        // Meta's business-scoped user id field for senders who adopted usernames (Meta BSUID guide,
        // https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/,
        // read 2026-09-22); `from` still wins whenever the phone number is present.
        from_user_id: z.string().max(128).optional(),
        timestamp,
        type: z.string().max(64),
        text: z.object({ body: z.string().max(1 << 20) }).optional(),
        // A tapped reply button arrives as type "interactive" with interactive.type "button_reply"
        // carrying the id and title we sent (360dialog webhook reference, "Received Answer to Reply
        // Button", checked 2026-09-21). Other interactive kinds are not conversation input here.
        interactive: z
          .object({
            type: z.string().max(64),
            button_reply: z
              .object({ id: z.string().min(1).max(256), title: z.string().max(64) })
              .optional(),
          })
          .optional(),
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
        const opaque = message.user_id ?? message.from_user_id;
        if (message.from && /^[1-9]\d{5,14}$/.test(message.from))
          address = { kind: 'phone', value: message.from };
        else if (opaque && /^[A-Z]{2}\.[A-Za-z0-9]{1,124}$/.test(opaque))
          address = { kind: 'opaque', value: opaque };
        else throw new ChannelError('recipient_invalid');
        const button =
          message.type === 'interactive' && message.interactive?.type === 'button_reply'
            ? message.interactive.button_reply
            : undefined;
        messages.push({
          providerId: message.id,
          address,
          eventAt: message.timestamp,
          ...(message.type === 'text' && message.text ? { text: message.text.body } : {}),
          ...(button ? { button: { id: button.id, title: button.title } } : {}),
        });
      }
      for (const status of value.statuses ?? [])
        statuses.push({ providerMessageId: status.id, state: status.status });
      if (messages.length + statuses.length > 100) throw new ChannelError('batch_too_large');
    }
  return { messages, statuses };
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
  async health(): Promise<WhatsAppHealth> {
    return cloudApiHealth(await this.request('/health_status?fields=id'));
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
  setBlocked(phone: string, blocked: boolean): Promise<WhatsAppBlockResult> {
    return cloudApiSetBlocked((...args) => this.request(...args), phone, blocked);
  }
  /** One reply; request bodies and fallback semantics are shared in `cloudApiSend`. */
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    return cloudApiSend((...args) => this.request(...args), input);
  }
}
/**
 * One 360dialog binding as a provider: its channel key's adapter plus its per-binding callback secret.
 * The callback carries the secret as a header; an existing callback owned by another URL is never
 * taken over.
 */
export function dialog360Provider(adapter: Dialog360, webhookSecret: string): WhatsAppProvider {
  return {
    health: () => adapter.health(),
    setBlocked: (phone, blocked) => adapter.setBlocked(phone, blocked),
    send: (input) => adapter.send(input),
    async inspectWebhook(url) {
      const current = await adapter.webhook();
      return {
        matches: current.url === url,
        authenticated: verifyWhatsAppWebhookSecret(
          current.headers?.[WHATSAPP_CALLBACK_HEADER],
          webhookSecret,
        ),
      };
    },
    async configureWebhook(url) {
      const existing = await adapter.webhook();
      if (existing.url && existing.url !== url)
        throw new ChannelError('webhook_ownership_conflict');
      if (
        existing.url !== url ||
        !verifyWhatsAppWebhookSecret(existing.headers?.[WHATSAPP_CALLBACK_HEADER], webhookSecret)
      )
        await adapter.configureWebhook(url, webhookSecret);
    },
  };
}

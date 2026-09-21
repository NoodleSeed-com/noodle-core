import { timingSafeEqual } from 'node:crypto';
import {
  type ChannelAddress,
  ChannelError,
  type ChannelInbound,
  type ChannelReplyButton,
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
        if (message.from && /^[1-9]\d{5,14}$/.test(message.from))
          address = { kind: 'phone', value: message.from };
        else if (message.user_id && /^[A-Z]{2}\.[A-Za-z0-9]{1,124}$/.test(message.user_id))
          address = { kind: 'opaque', value: message.user_id };
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
/** A 4xx that judges the payload itself; auth, throttling and timeouts are no reason to resend differently. */
function rejectedPayload(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
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
      .object({
        id: identifier,
        health_status: z.object({ can_send_message: z.enum(['AVAILABLE', 'LIMITED', 'BLOCKED']) }),
      })
      .safeParse(await boundedJson(response));
    if (!parsed.success) throw new ChannelError('provider_response_invalid');
    return {
      phoneNumberId: parsed.data.id,
      // LIMITED meets provider messaging requirements; provider limits still govern each send.
      canSend: parsed.data.health_status.can_send_message !== 'BLOCKED',
      status: parsed.data.health_status.can_send_message,
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
  /**
   * One reply. With buttons the review goes as an interactive reply-button message: at most three
   * buttons, titles up to 20 characters, ids up to 256 and a body up to 1024 characters, per the
   * Meta Cloud API reply-buttons reference that the 360dialog Cloud API host relays (360dialog's own
   * interactive-messages page states only the three-button limit; its webhook reference gives the
   * inbound shape); all checked 2026-09-21. A payload the provider rejects outright dispatched
   * nothing, so the same text goes plain instead; an ambiguous outcome is never retried.
   */
  async send(input: {
    readonly to: ChannelAddress;
    readonly text: string;
    readonly buttons?: readonly ChannelReplyButton[] | undefined;
  }): Promise<{
    state: 'accepted' | 'failed' | 'unknown';
    providerMessageId?: string;
    code?: string;
  }> {
    if (!input.text || input.text.length > 4096) return { state: 'failed', code: 'reply_invalid' };
    const buttons = input.buttons ?? [];
    const interactive =
      buttons.length > 0 &&
      buttons.length <= 3 &&
      input.text.length <= 1024 &&
      buttons.every((button) => button.id.length <= 256 && button.title.length <= 20);
    const envelope = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      ...(input.to.kind === 'phone' ? { to: input.to.value } : { recipient: input.to.value }),
    };
    try {
      let code: string | undefined;
      let response = interactive
        ? await this.request('/messages', 'POST', {
            ...envelope,
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: input.text },
              action: {
                buttons: buttons.map((button) => ({
                  type: 'reply',
                  reply: { id: button.id, title: button.title },
                })),
              },
            },
          })
        : undefined;
      if (response !== undefined && !response.ok && rejectedPayload(response.status)) {
        await response.body?.cancel();
        code = 'interactive_rejected';
        response = undefined;
      }
      if (response === undefined)
        response = await this.request('/messages', 'POST', {
          ...envelope,
          type: 'text',
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
        ? {
            state: 'accepted',
            providerMessageId: parsed.data.messages[0]!.id,
            ...(code === undefined ? {} : { code }),
          }
        : { state: 'unknown', code: 'provider_receipt_invalid' };
    } catch {
      return { state: 'unknown', code: 'send_outcome_unknown' };
    }
  }
}

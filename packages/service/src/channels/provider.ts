import {
  type ChannelAddress,
  ChannelError,
  type ChannelReplyButton,
} from '@noodle-borg/assistant-gateway/portable';
import { z } from 'zod';

/**
 * The Cloud API operations every WhatsApp provider performs with the same request bodies: 360dialog
 * relays them on its own host and key, Meta serves them on graph.facebook.com per phone number. A
 * provider supplies only `request`, bound to its base URL, path prefix and credential.
 */
export type CloudApiRequest = (path: string, method?: string, body?: unknown) => Promise<Response>;
export interface WhatsAppHealth {
  readonly phoneNumberId: string;
  readonly canSend: boolean;
  readonly status: 'AVAILABLE' | 'LIMITED' | 'BLOCKED';
  /** Set when the only thing blocking the account is its missing or failing payment method. */
  readonly reason?: 'payment_method_required';
}
export interface WhatsAppBlockResult {
  state: 'confirmed' | 'error' | 'unknown';
  code?: string;
}
export interface WhatsAppSendResult {
  state: 'accepted' | 'failed' | 'unknown';
  providerMessageId?: string;
  code?: string;
}
export interface WhatsAppSendInput {
  readonly to: ChannelAddress;
  readonly text: string;
  readonly buttons?: readonly ChannelReplyButton[] | undefined;
}
/** What the runtime needs from a provider; webhook semantics are provider-specific. */
export interface WhatsAppProvider {
  health(): Promise<WhatsAppHealth>;
  setBlocked(phone: string, blocked: boolean): Promise<WhatsAppBlockResult>;
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult>;
  /** Whether callbacks for this binding reach `url` and are authenticated. */
  inspectWebhook(url: string): Promise<{ matches: boolean; authenticated: boolean }>;
  /** Route this binding's callbacks to `url`, refusing to take over another owner's callback. */
  configureWebhook(url: string): Promise<void>;
}
const identifier = z.string().min(1).max(512);
/** A 4xx that judges the payload itself; auth, throttling and timeouts are no reason to resend differently. */
function rejectedPayload(status: number): boolean {
  return status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);
}
export async function boundedJson(response: Response): Promise<unknown> {
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
const sendState = z.enum(['AVAILABLE', 'LIMITED', 'BLOCKED']);
/**
 * 141006 reads "There is an error with the payment method" (observed on a WABA with no payment
 * method, 2026-09-22). Meta requires a business to "first attach a payment method ... before they
 * can begin messaging" (Embedded Signup overview and business customer support, read 2026-09-22),
 * so the block stands; it is only named so readiness can say what to fix.
 */
const PAYMENT_BLOCKS = new Set([141006]);
/**
 * Parse a Cloud API health read. The aggregate `can_send_message` is authoritative. When the phone
 * number itself can send and every blocked entity names only payment errors, the block carries
 * `payment_method_required`.
 */
export async function cloudApiHealth(response: Response): Promise<WhatsAppHealth> {
  if (!response.ok) throw new ChannelError('provider_unavailable');
  const parsed = z
    .object({
      id: identifier,
      health_status: z.object({
        can_send_message: sendState,
        entities: z
          .array(
            z.object({
              entity_type: z.string().max(64),
              can_send_message: sendState.optional(),
              errors: z
                .array(z.object({ error_code: z.number().int() }))
                .max(50)
                .optional(),
            }),
          )
          .max(20)
          .optional(),
      }),
    })
    .safeParse(await boundedJson(response));
  if (!parsed.success) throw new ChannelError('provider_response_invalid');
  const { can_send_message: aggregate, entities = [] } = parsed.data.health_status;
  const phone = entities.find((entity) => entity.entity_type === 'PHONE_NUMBER');
  const paymentOnly =
    aggregate === 'BLOCKED' &&
    phone !== undefined &&
    phone.can_send_message !== 'BLOCKED' &&
    entities
      .filter((entity) => entity.can_send_message === 'BLOCKED')
      .every(({ errors = [] }) => {
        return errors.length > 0 && errors.every((error) => PAYMENT_BLOCKS.has(error.error_code));
      });
  return {
    phoneNumberId: parsed.data.id,
    // LIMITED meets provider messaging requirements; provider limits still govern each send.
    canSend: aggregate !== 'BLOCKED',
    status: aggregate,
    ...(paymentOnly ? { reason: 'payment_method_required' as const } : {}),
  };
}
export async function cloudApiSetBlocked(
  request: CloudApiRequest,
  phone: string,
  blocked: boolean,
): Promise<WhatsAppBlockResult> {
  try {
    const response = await request('/block_users', blocked ? 'POST' : 'DELETE', {
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
export async function cloudApiSend(
  request: CloudApiRequest,
  input: WhatsAppSendInput,
): Promise<WhatsAppSendResult> {
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
      ? await request('/messages', 'POST', {
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
      response = await request('/messages', 'POST', {
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

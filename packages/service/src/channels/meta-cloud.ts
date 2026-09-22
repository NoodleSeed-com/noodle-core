import { ChannelError } from '@noodle-borg/assistant-gateway/portable';
import { guardedFetch } from '@noodle-borg/connector-http';
import { z } from 'zod';
import {
  boundedJson,
  type CloudApiRequest,
  cloudApiHealth,
  cloudApiSend,
  cloudApiSetBlocked,
  type WhatsAppBlockResult,
  type WhatsAppHealth,
  type WhatsAppProvider,
  type WhatsAppSendInput,
  type WhatsAppSendResult,
} from './provider.js';

/**
 * Graph API version for every Meta call. Graph API changelog (read 2026-09-22,
 * https://developers.facebook.com/docs/graph-api/changelog): v25.0 released 2026-02-18 and available
 * until 2028-07-29; v26.0 (2026-07-29) is newer, but Meta's WhatsApp references and Noodle Seed's
 * App Dashboard examples use v25.0. Operators may pin another with NOODLE_WHATSAPP_META_GRAPH_VERSION.
 */
export const WHATSAPP_META_GRAPH_VERSION = 'v25.0';
/** The one callback every Meta-connected number shares; bindings are found by phone-number id. */
export const WHATSAPP_META_CALLBACK_PATH = '/v1/channels/whatsapp/meta';
/** Platform configuration for Noodle Seed's Meta app: one app, one callback, every Meta binding. */
export interface WhatsAppMetaConfig {
  readonly appId: string;
  /** Signs every callback (`X-Hub-Signature-256`). Never logged or sent to Graph. */
  readonly appSecret: string;
  /** Echoed by Meta in the `hub.verify_token` handshake. */
  readonly verifyToken: string;
  readonly graphVersion: string;
}
const node = /^\d{1,32}$/;
const subscriptions = z.object({
  data: z
    .array(z.object({ whatsapp_business_api_data: z.object({ id: z.string().max(64) }) }))
    .max(100),
});
/**
 * One Meta-connected number, called directly on graph.facebook.com with the business's token.
 * Sources, all read 2026-09-22 and using v25.0 in their examples:
 * - send: POST /{phone_number_id}/messages, Bearer token, `messages[].id` receipt
 *   (https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages); a business-scoped
 *   user id goes in `recipient` instead of `to`
 *   (https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/).
 * - health: GET /{node}?fields=health_status returns `id` and `health_status.can_send_message`
 *   AVAILABLE | LIMITED | BLOCKED (https://developers.facebook.com/docs/whatsapp/cloud-api/health-status).
 * - block: POST | DELETE /{phone_number_id}/block_users, receipts in `block_users.added_users` /
 *   `removed_users` (https://developers.facebook.com/docs/whatsapp/cloud-api/block-users).
 * - webhooks: GET | POST /{waba_id}/subscribed_apps; the GET lists
 *   `data[].whatsapp_business_api_data.id`, the POST answers `{"success": true}`
 *   (https://developers.facebook.com/docs/whatsapp/embedded-signup/webhooks).
 */
export class MetaCloud implements WhatsAppProvider {
  private readonly phone: CloudApiRequest;
  constructor(
    private readonly token: string,
    private readonly asset: { readonly phoneNumberId: string; readonly wabaId: string },
    private readonly app: Pick<WhatsAppMetaConfig, 'appId' | 'graphVersion'>,
    private readonly fetcher: typeof fetch = (url, init) => guardedFetch(new URL(url), init),
  ) {
    if (!/^v\d{1,3}\.\d{1,2}$/.test(app.graphVersion) || !node.test(app.appId))
      throw new ChannelError('provider_configuration_invalid');
    this.phone = (path, method, body) => this.request(asset.phoneNumberId, path, method, body);
  }
  private async request(
    id: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Response> {
    if (!node.test(id)) throw new ChannelError('provider_asset_invalid');
    return this.fetcher(`https://graph.facebook.com/${this.app.graphVersion}/${id}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  }
  async health(): Promise<WhatsAppHealth> {
    return cloudApiHealth(await this.phone('?fields=id,health_status'));
  }
  setBlocked(phone: string, blocked: boolean): Promise<WhatsAppBlockResult> {
    return cloudApiSetBlocked(this.phone, phone, blocked);
  }
  send(input: WhatsAppSendInput): Promise<WhatsAppSendResult> {
    return cloudApiSend(this.phone, input);
  }
  private async subscribed(): Promise<boolean> {
    const response = await this.request(this.asset.wabaId, '/subscribed_apps');
    if (!response.ok) {
      await response.body?.cancel();
      throw new ChannelError('provider_unavailable');
    }
    const parsed = subscriptions.safeParse(await boundedJson(response));
    if (!parsed.success) throw new ChannelError('provider_response_invalid');
    return parsed.data.data.some((app) => app.whatsapp_business_api_data.id === this.app.appId);
  }
  /**
   * `matches` means the WABA delivers to this Meta app; `authenticated` means the platform holds the
   * app secret that signs callbacks, which constructing this adapter requires. The app-level
   * callback URL is set once in the Meta App Dashboard and is not read here.
   */
  async inspectWebhook(_url: string): Promise<{ matches: boolean; authenticated: boolean }> {
    return { matches: await this.subscribed(), authenticated: true };
  }
  async configureWebhook(_url: string): Promise<void> {
    if (await this.subscribed()) return;
    const response = await this.request(this.asset.wabaId, '/subscribed_apps', 'POST');
    const parsed = response.ok
      ? z.object({ success: z.literal(true) }).safeParse(await boundedJson(response))
      : undefined;
    if (!response.ok) await response.body?.cancel();
    if (!parsed?.success) throw new ChannelError('webhook_configuration_failed');
  }
}

import { createHash } from 'node:crypto';
import type { Logger } from '@noodle-borg/transport-http';
import type { ControlPlaneStore, WelcomeEmailRecord } from './store.js';

const DOCS_URL = 'https://docs.noodleseed.dev/docs/quickstart';
const LOGO_URL = 'https://noodleseed.dev/noodle-seed-logo-light.svg';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DELIVERY_TIMEOUT_MS = 10_000;
const LEASE_MS = 30_000;
const BASE_RETRY_MS = 60_000;
const MAX_RETRY_MS = 24 * 60 * 60 * 1000;
const MAX_BATCH_SIZE = 25;
const DEFAULT_WELCOME_FROM = 'Asad <asad@noodleseed.com>';
const DEFAULT_INVITATION_FROM = 'Noodle Seed <hello@noodleseed.com>';

export const WELCOME_EMAIL_SWEEP_INTERVAL_MS = 30_000;

export interface RenderedWelcomeEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function renderWelcomeEmail(
  input: { readonly firstName?: string } = {},
): RenderedWelcomeEmail {
  const subject = 'Welcome to Noodle Seed';
  const greeting = input.firstName !== undefined ? `Hi ${plainText(input.firstName)},` : 'Hi,';
  const text = `${greeting}

I'm Asad, founder of Noodle Seed. I wanted to personally welcome you to the developer platform.

We are building Noodle Seed so you can create and run production-grade AI apps, plugins, and MCP servers without stitching the infrastructure together yourself.

The quickest way to get started is here:
${DOCS_URL}

If you get stuck, or simply want to share an idea, reply and tell me what you are building. I read every response.

Welcome aboard,
Asad - Co-Founder & CTO`;
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${subject}</title>
  </head>
  <body style="margin:0;background:#f4f2ed;color:#171714;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">A personal welcome from Asad, founder of Noodle Seed.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ed;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dedbd3;border-radius:16px;">
          <tr><td style="padding:40px 40px 18px;"><img src="${LOGO_URL}" width="200" height="31" alt="Noodle Seed" style="display:block;width:200px;max-width:100%;height:auto;"></td></tr>
          <tr><td style="padding:0 40px 40px;">
            <h1 style="margin:0 0 24px;font-size:30px;line-height:1.2;letter-spacing:-0.03em;">Welcome to Noodle Seed</h1>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 18px;font-size:16px;line-height:1.65;">I'm Asad, founder of Noodle Seed. I wanted to personally welcome you to the developer platform.</p>
            <p style="margin:0 0 26px;font-size:16px;line-height:1.65;">We are building Noodle Seed so you can create and run production-grade AI apps, plugins, and MCP servers without stitching the infrastructure together yourself.</p>
            <a href="${DOCS_URL}" style="display:inline-block;background:#171714;color:#ffffff;text-decoration:none;font-size:15px;font-weight:650;padding:13px 20px;border-radius:999px;">Open the developer docs</a>
            <p style="margin:28px 0 18px;font-size:16px;line-height:1.65;">If you get stuck, or simply want to share an idea, reply and tell me what you are building. I read every response.</p>
            <p style="margin:0;font-size:16px;line-height:1.65;">Welcome aboard,<br><strong>Asad</strong> <span style="color:#6b685f;">- Co-Founder &amp; CTO</span></p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
  return { subject, text, html };
}

export interface InvitationEmailContent {
  readonly inviterEmail: string;
  readonly orgName: string;
  readonly role: 'owner' | 'developer';
  readonly acceptUrl: string;
  readonly expiresAt: string;
}

export function renderInvitationEmail(input: InvitationEmailContent): RenderedWelcomeEmail {
  const orgName = headerText(input.orgName);
  const inviterEmail = headerText(input.inviterEmail);
  const subject = `${displayNameFromEmail(inviterEmail)} invited you to ${orgName} on Noodle Seed`;
  const text = `${inviterEmail} invited you to join ${orgName} as ${input.role} on Noodle Seed.

Accept invitation:
${input.acceptUrl}

This invitation expires on ${input.expiresAt.slice(0, 10)}. If you were not expecting it, you can ignore this email.`;
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(subject)}</title></head>
  <body style="margin:0;background:#f4f2ed;color:#171714;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You have been invited to collaborate on Noodle Seed.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f2ed;padding:32px 16px;"><tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid #dedbd3;border-radius:16px;">
        <tr><td style="padding:40px 40px 18px;"><img src="${LOGO_URL}" width="200" height="31" alt="Noodle Seed" style="display:block;width:200px;max-width:100%;height:auto;"></td></tr>
        <tr><td style="padding:0 40px 40px;">
          <h1 style="margin:0 0 24px;font-size:30px;line-height:1.2;letter-spacing:-0.03em;">Join ${escapeHtml(orgName)}</h1>
          <p style="margin:0 0 18px;font-size:16px;line-height:1.65;"><strong>${escapeHtml(inviterEmail)}</strong> invited you to join <strong>${escapeHtml(orgName)}</strong> as ${input.role}.</p>
          <p style="margin:0 0 26px;font-size:16px;line-height:1.65;">Accept the invitation to collaborate on apps, deployments, and infrastructure in Noodle Seed.</p>
          <a href="${escapeHtml(input.acceptUrl)}" style="display:inline-block;background:#171714;color:#ffffff;text-decoration:none;font-size:15px;font-weight:650;padding:13px 20px;border-radius:999px;">Accept invitation</a>
          <p style="margin:28px 0 0;font-size:13px;line-height:1.6;color:#6b685f;">This invitation expires on ${escapeHtml(input.expiresAt.slice(0, 10))}. If you were not expecting it, you can ignore this email.</p>
        </td></tr>
      </table>
    </td></tr></table>
  </body>
</html>`;
  return { subject, text, html };
}

export interface InvitationEmailInput extends InvitationEmailContent {
  readonly invitationId: string;
  readonly email: string;
}

export interface InvitationEmailSender {
  sendInvitation(input: InvitationEmailInput): Promise<{ readonly providerMessageId: string }>;
}

export interface WelcomeEmailSender {
  send(input: Pick<WelcomeEmailRecord, 'subject' | 'email' | 'firstName'>): Promise<{
    readonly providerMessageId: string;
  }>;
}

export interface ResendEmailSenderOptions {
  readonly apiKey: string;
  readonly welcomeFrom: string;
  readonly invitationFrom: string;
  readonly welcomeReplyTo?: string;
  readonly invitationReplyTo?: string;
  readonly fetch?: typeof fetch;
}

export function resolveWelcomeEmailConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResendEmailSenderOptions | undefined {
  const apiKey = env.RESEND_API_KEY?.trim();
  const welcomeFrom = env.NOODLE_WELCOME_EMAIL_FROM?.trim();
  const invitationFrom = env.NOODLE_INVITATION_EMAIL_FROM?.trim();
  const welcomeReplyTo = env.NOODLE_WELCOME_EMAIL_REPLY_TO?.trim();
  const invitationReplyTo = env.NOODLE_INVITATION_EMAIL_REPLY_TO?.trim();
  if (!apiKey && !welcomeFrom && !invitationFrom && !welcomeReplyTo && !invitationReplyTo) {
    return undefined;
  }
  if (!apiKey) throw new Error('RESEND_API_KEY is required when transactional email is configured');
  return {
    apiKey,
    welcomeFrom: welcomeFrom || DEFAULT_WELCOME_FROM,
    invitationFrom: invitationFrom || DEFAULT_INVITATION_FROM,
    ...(welcomeReplyTo ? { welcomeReplyTo } : {}),
    ...(invitationReplyTo ? { invitationReplyTo } : {}),
  };
}

export class ResendEmailSender implements WelcomeEmailSender, InvitationEmailSender {
  readonly #apiKey: string;
  readonly #welcomeFrom: string;
  readonly #invitationFrom: string;
  readonly #welcomeReplyTo: string | undefined;
  readonly #invitationReplyTo: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: ResendEmailSenderOptions) {
    this.#apiKey = options.apiKey;
    this.#welcomeFrom = options.welcomeFrom;
    this.#invitationFrom = options.invitationFrom;
    this.#welcomeReplyTo = options.welcomeReplyTo;
    this.#invitationReplyTo = options.invitationReplyTo;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async send(input: Pick<WelcomeEmailRecord, 'subject' | 'email' | 'firstName'>): Promise<{
    readonly providerMessageId: string;
  }> {
    return this.#send(
      input.email,
      `welcome.${hash(input.subject)}`,
      renderWelcomeEmail(input.firstName !== undefined ? { firstName: input.firstName } : {}),
      this.#welcomeFrom,
      this.#welcomeReplyTo,
    );
  }

  sendInvitation(input: InvitationEmailInput): Promise<{ readonly providerMessageId: string }> {
    return this.#send(
      input.email,
      `invitation.${hash(input.invitationId)}`,
      renderInvitationEmail(input),
      this.#invitationFrom,
      this.#invitationReplyTo,
    );
  }

  async #send(
    recipient: string,
    idempotencyKey: string,
    content: RenderedWelcomeEmail,
    from: string,
    replyTo?: string,
  ): Promise<{ readonly providerMessageId: string }> {
    const response = await this.#fetch(RESEND_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        ...content,
      }),
    });
    if (!response.ok) {
      throw new Error(`welcome email provider rejected request with status ${response.status}`);
    }
    const body = (await response.json()) as { readonly id?: unknown };
    if (typeof body.id !== 'string' || body.id.length === 0) {
      throw new Error('welcome email provider returned an invalid response');
    }
    return { providerMessageId: body.id };
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function headerText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
}

function plainText(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 100);
}

function displayNameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? 'A teammate';
  const words = local.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return 'A teammate';
  return words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export interface WelcomeEmailWorkerOptions {
  readonly store: ControlPlaneStore;
  readonly sender: WelcomeEmailSender;
  readonly clock?: () => Date;
  readonly logger?: Logger;
}

export class WelcomeEmailWorker {
  readonly #store: ControlPlaneStore;
  readonly #sender: WelcomeEmailSender;
  readonly #clock: () => Date;
  readonly #logger: Logger | undefined;
  #running = false;

  constructor(options: WelcomeEmailWorkerOptions) {
    this.#store = options.store;
    this.#sender = options.sender;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let processed = 0; processed < MAX_BATCH_SIZE; processed += 1) {
        const record = await this.#store.claimWelcomeEmail({
          now: this.#clock(),
          leaseMs: LEASE_MS,
        });
        if (record === undefined) return;
        try {
          const result = await this.#sender.send(record);
          await this.#store.markWelcomeEmailSent({
            subject: record.subject,
            providerMessageId: result.providerMessageId,
          });
          this.#logger?.info('welcome_email.delivered', { attempt: record.attemptCount });
        } catch {
          const delay = Math.min(BASE_RETRY_MS * 2 ** (record.attemptCount - 1), MAX_RETRY_MS);
          await this.#store.markWelcomeEmailFailed({
            subject: record.subject,
            nextAttemptAt: new Date(this.#clock().getTime() + delay),
          });
          this.#logger?.warn('welcome_email.delivery_failed', { attempt: record.attemptCount });
        }
      }
    } catch {
      this.#logger?.warn('welcome_email.sweep_failed', { status: 500 });
    } finally {
      this.#running = false;
    }
  }
}

export function startWelcomeEmailWorker(options: WelcomeEmailWorkerOptions): NodeJS.Timeout {
  const worker = new WelcomeEmailWorker(options);
  void worker.runOnce();
  const timer = setInterval(() => void worker.runOnce(), WELCOME_EMAIL_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

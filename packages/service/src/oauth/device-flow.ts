import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { renderOAuthPage } from './branding.js';
import type { NoodleOAuthProvider } from './provider.js';
import type { OAuthStore } from './store.js';
import { hashToken, randomToken } from './tokens.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const DEVICE_TTL_SECONDS = 600;
const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** RFC 8628 endpoints, backed by the existing authorization-code consent path in the browser. */
export class DeviceAuthorizationFlow {
  readonly #issuer: string;
  readonly #store: OAuthStore;
  readonly #provider: NoodleOAuthProvider;
  readonly #nowSeconds: () => number;

  constructor(input: {
    readonly issuer: string;
    readonly store: OAuthStore;
    readonly provider: NoodleOAuthProvider;
    readonly now?: () => number;
  }) {
    this.#issuer = input.issuer.replace(/\/+$/, '');
    this.#store = input.store;
    this.#provider = input.provider;
    this.#nowSeconds = input.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async handleAuthorization(req: Request, res: Response): Promise<void> {
    const body = formBody(req);
    const clientId = stringField(body, 'client_id');
    const resource = stringField(body, 'resource');
    const scope = optionalStringField(body, 'scope');
    if (clientId === undefined || resource === undefined || !this.#validResource(resource)) {
      sendOAuthError(res, 'invalid_request');
      return;
    }
    const client = await this.#store.getClient(clientId);
    const callback = this.#callbackUrl();
    if (
      client === undefined ||
      client.token_endpoint_auth_method !== 'none' ||
      !client.grant_types?.includes(DEVICE_GRANT) ||
      !client.redirect_uris.includes(callback)
    ) {
      sendOAuthError(res, 'invalid_client', 401);
      return;
    }

    const rawDeviceCode = randomToken();
    const rawUserCode = userCode();
    const now = this.#nowSeconds();
    await this.#store.createDeviceAuthorization({
      deviceCode: hashToken(rawDeviceCode),
      userCode: hashToken(normalizeUserCode(rawUserCode)),
      clientId,
      resource: normalizeUrl(resource),
      ...(scope !== undefined ? { scope } : {}),
      status: 'pending',
      expiresAt: now + DEVICE_TTL_SECONDS,
      nextPollAt: now,
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
    });
    const verificationUri = `${this.#issuer}/device`;
    const complete = new URL(verificationUri);
    complete.searchParams.set('user_code', rawUserCode);
    res.setHeader('cache-control', 'no-store');
    res.json({
      device_code: rawDeviceCode,
      user_code: rawUserCode,
      verification_uri: verificationUri,
      verification_uri_complete: complete.href,
      expires_in: DEVICE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    });
  }

  handleVerificationPage(req: Request, res: Response): void {
    const code = typeof req.query.user_code === 'string' ? req.query.user_code : '';
    res.status(200).type('html').send(renderDeviceCodePage(code));
  }

  async handleVerification(req: Request, res: Response): Promise<void> {
    const rawUserCode = stringField(formBody(req), 'user_code');
    const normalized = rawUserCode === undefined ? undefined : normalizeUserCode(rawUserCode);
    const device =
      normalized === undefined
        ? undefined
        : await this.#store.getDeviceAuthorizationByUserCode(hashToken(normalized));
    if (device === undefined) {
      res
        .status(400)
        .type('html')
        .send(renderDeviceCodePage(rawUserCode ?? '', true));
      return;
    }

    const rawState = randomToken();
    const challenge = randomToken();
    await this.#store.createDeviceBrowserSession({
      state: hashToken(rawState),
      deviceCode: device.deviceCode,
      clientId: device.clientId,
      resource: device.resource,
      codeChallenge: challenge,
      expiresAt: device.expiresAt,
    });
    const authorize = new URL(`${this.#issuer}/authorize`);
    authorize.searchParams.set('client_id', device.clientId);
    authorize.searchParams.set('redirect_uri', this.#callbackUrl());
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('state', rawState);
    authorize.searchParams.set('resource', device.resource);
    if (device.scope !== undefined) authorize.searchParams.set('scope', device.scope);
    res.redirect(302, authorize.href);
  }

  async handleCallback(req: Request, res: Response): Promise<void> {
    const rawState = typeof req.query.state === 'string' ? req.query.state : undefined;
    const session =
      rawState === undefined
        ? undefined
        : await this.#store.consumeDeviceBrowserSession(hashToken(rawState));
    if (session === undefined) {
      res.status(400).type('html').send(renderCompletionPage(false));
      return;
    }
    if (typeof req.query.error === 'string') {
      await this.#store.denyDeviceAuthorization(session.deviceCode);
      res.status(200).type('html').send(renderCompletionPage(false));
      return;
    }
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const approved =
      code !== undefined && (await this.#provider.completeDeviceAuthorization(session, code));
    res
      .status(approved ? 200 : 400)
      .type('html')
      .send(renderCompletionPage(approved));
  }

  async handleToken(req: Request, res: Response): Promise<void> {
    const body = formBody(req);
    const clientId = stringField(body, 'client_id');
    const rawDeviceCode = stringField(body, 'device_code');
    const resource = optionalStringField(body, 'resource');
    if (clientId === undefined || rawDeviceCode === undefined) {
      sendOAuthError(res, 'invalid_request');
      return;
    }
    const client = await this.#store.getClient(clientId);
    if (
      client === undefined ||
      client.token_endpoint_auth_method !== 'none' ||
      !client.grant_types?.includes(DEVICE_GRANT)
    ) {
      sendOAuthError(res, 'invalid_client', 401);
      return;
    }
    const result = await this.#store.pollDeviceAuthorization({
      deviceCode: hashToken(rawDeviceCode),
      clientId,
      ...(resource !== undefined ? { resource: normalizeUrl(resource) } : {}),
      nowSeconds: this.#nowSeconds(),
    });
    if (result.status !== 'approved') {
      sendOAuthError(res, result.status);
      return;
    }
    const tokens = await this.#provider.issueDeviceTokens(result.record);
    if (
      !(await this.#store.completeDeviceTokenIssuance(
        result.record.deviceCode,
        result.record.clientId,
      ))
    ) {
      sendOAuthError(res, 'expired_token');
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.json(tokens);
  }

  #callbackUrl(): string {
    return `${this.#issuer}/oauth/device/callback`;
  }

  #validResource(resource: string): boolean {
    try {
      const normalized = normalizeUrl(resource);
      return (
        normalized === normalizeUrl(this.#issuer) || normalized === `${this.#issuer}/developer/cli`
      );
    } catch {
      return false;
    }
  }
}

function formBody(req: Request): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionalStringField(body: Record<string, unknown>, name: string): string | undefined {
  return stringField(body, name);
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.href;
}

function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z2-9]/g, '');
}

function userCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let value = '';
  for (let index = 0; index < 8; index += 1) {
    value += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return `${value.slice(0, 4)}-${value.slice(4)}`;
}

function sendOAuthError(res: Response, error: string, status = 400): void {
  res.setHeader('cache-control', 'no-store');
  res.status(status).json({ error });
}

function renderDeviceCodePage(code: string, invalid = false): string {
  return renderOAuthPage({
    title: 'Sign in — Noodle Seed',
    kicker: 'CLI sign in',
    heading: 'Enter your device code',
    contentHtml: `${
      invalid ? '<p class="ns-lede">That code is invalid or expired. Try the code again.</p>' : ''
    }${
      code === ''
        ? ''
        : `<p class="ns-lede">Confirm <strong>${escapeHtml(code)}</strong> matches the code shown in your terminal.</p>`
    }<form method="post" action="/device">
      <label for="user_code">Device code</label>
      <input id="user_code" name="user_code" value="${escapeHtml(code)}" autocomplete="one-time-code" required />
      <div class="btn-glow"><button class="btn btn-primary" type="submit">Continue</button></div>
    </form>`,
  });
}

function renderCompletionPage(approved: boolean): string {
  return renderOAuthPage({
    title: `${approved ? 'Signed in' : 'Sign-in denied'} — Noodle Seed`,
    kicker: approved ? 'Complete' : 'Not completed',
    heading: approved ? 'You are signed in' : 'Sign-in was not completed',
    contentHtml: approved
      ? '<p class="ns-lede">You can return to your terminal. This window can now be closed.</p>'
      : '<p class="ns-lede">Return to your terminal and start sign-in again if you still want to continue.</p>',
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character] ?? character;
  });
}

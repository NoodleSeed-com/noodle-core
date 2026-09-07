import { OAuth2Client } from 'google-auth-library';
import { canonicalOAuthIdentityPreferences } from './identity-preferences.js';
import type { UpstreamAuthorizationOptions } from './upstream-human.js';

/** A verified upstream human identity from "Sign in with Google". */
export interface GoogleIdentity {
  readonly subject: string;
  readonly email: string;
  readonly locale?: string;
  readonly timeZone?: string;
}

/**
 * The Google-federation leg of the authorization server (OA-2,
 * [ADR 0042](../../../../docs/decisions/0042-self-hosted-oauth-authorization-server.md)): the AS authenticates
 * the human via Google, then issues its own Noodle tokens. Injectable so tests can supply a fake without a
 * live Google round-trip; production uses {@link GoogleOAuthAuthenticator} (`google-auth-library`, the same
 * library the control plane already uses — [ADR 0039]).
 */
export interface GoogleAuthenticator {
  /** The "Sign in with Google" URL to redirect the user-agent to, carrying our `state` nonce. */
  authorizationUrl(state: string, options?: UpstreamAuthorizationOptions): URL;
  /** Exchange Google's authorization `code` for the verified user identity (or throw on failure). */
  exchange(code: string): Promise<GoogleIdentity>;
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The AS's own Google callback URL (e.g. `https://cloud.noodleseed.dev/oauth/google/callback`). */
  readonly redirectUri: string;
}

export class GoogleOAuthAuthenticator implements GoogleAuthenticator {
  readonly #config: GoogleOAuthConfig;
  readonly #client: OAuth2Client;

  constructor(config: GoogleOAuthConfig) {
    this.#config = config;
    this.#client = new OAuth2Client({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
    });
  }

  authorizationUrl(state: string, options?: UpstreamAuthorizationOptions): URL {
    const forceAuthentication = options?.forceAuthentication === true;
    const url = new URL(
      this.#client.generateAuthUrl({
        scope: ['openid', 'email', 'profile'],
        state,
        access_type: 'online',
        // Force the account chooser so a returning user can pick the identity; also a UX guard against
        // silently reusing a wrong session.
        prompt: forceAuthentication ? 'login' : 'select_account',
      }),
    );
    if (forceAuthentication) url.searchParams.set('max_age', '0');
    return url;
  }

  async exchange(code: string): Promise<GoogleIdentity> {
    const { tokens } = await this.#client.getToken(code);
    const idToken = tokens.id_token;
    if (!idToken) throw new Error('Google token response had no id_token');
    const ticket = await this.#client.verifyIdToken({ idToken, audience: this.#config.clientId });
    const payload = ticket.getPayload();
    const subject = payload?.sub;
    const email = payload?.email;
    const emailVerified = payload?.email_verified;
    if (typeof subject !== 'string' || typeof email !== 'string' || emailVerified !== true) {
      throw new Error('Google identity is missing a verified subject/email');
    }
    const claims = payload as unknown as Readonly<Record<string, unknown>>;
    const preferences = canonicalOAuthIdentityPreferences({
      locale: claims.locale,
      timeZone: claims.zoneinfo,
    });
    return {
      subject,
      email,
      ...preferences,
    };
  }
}

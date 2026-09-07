import type { GoogleIdTokenVerifier } from '@noodle-borg/control-plane/portable';

type GoogleTokenPayload = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  given_name?: unknown;
};

interface GoogleVerifierClient {
  verifyIdToken(input: {
    idToken: string;
    // One or more accepted audiences; google-auth-library accepts a token whose `aud` matches any.
    audience: string | string[];
  }): Promise<{ getPayload(): GoogleTokenPayload | undefined }>;
}

/**
 * The production `google-auth-library` verifier for the Google control-plane gates. It stays in the
 * hosted service so `@noodle-borg/control-plane` (where the gates live) carries no vendor SDK.
 */
export class GoogleOAuthVerifier implements GoogleIdTokenVerifier {
  #clientPromise: Promise<GoogleVerifierClient> | undefined;

  async verify(
    token: string,
    audience: string | readonly string[],
  ): Promise<{ subject: string; email: string; givenName?: string }> {
    const client = await this.#client();
    const audiences = typeof audience === 'string' ? [audience] : [...audience];
    const ticket = await client.verifyIdToken({ idToken: token, audience: audiences });
    const payload = ticket.getPayload();
    const subject = payload?.sub;
    const email = payload?.email;
    const emailVerified = payload?.email_verified;
    if (typeof subject !== 'string' || typeof email !== 'string' || emailVerified !== true) {
      throw new Error('Google token is missing a verified subject/email');
    }
    const givenName = payload?.given_name;
    return {
      subject,
      email,
      ...(typeof givenName === 'string' && givenName.trim() !== ''
        ? { givenName: givenName.trim().slice(0, 100) }
        : {}),
    };
  }

  #client(): Promise<GoogleVerifierClient> {
    this.#clientPromise ??= import('google-auth-library').then((m) => {
      const client = new m.OAuth2Client();
      return {
        verifyIdToken: (input) => client.verifyIdToken(input),
      } satisfies GoogleVerifierClient;
    });
    return this.#clientPromise;
  }
}

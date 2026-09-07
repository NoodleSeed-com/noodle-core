import { TextDecoder } from 'node:util';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import type { ServeServiceOptions } from '@noodle-borg/service';
import { GoogleOAuthAuthenticator } from '@noodle-borg/service/oauth-google';

import type { SelfHostConfig } from './config.js';

type OwnerAuthOptions = Pick<
  ServeServiceOptions,
  'authServerIssuer' | 'verifyOwnerToken' | 'oauth'
>;

/** Map the validated self-host owner-auth group onto the portable service boundary. */
export async function ownerAuthOptions(
  config: SelfHostConfig['ownerAuth'],
): Promise<OwnerAuthOptions> {
  if (config === undefined) return {};

  if (config.kind === 'external') {
    return {
      authServerIssuer: config.issuer,
      verifyOwnerToken: createJwtVerifier({ issuer: config.issuer, jwksUri: config.jwksUri }),
    };
  }

  const privateKeyPem = decodeSigningKey(config.signingKeyBase64);
  try {
    return {
      oauth: {
        issuer: config.issuer,
        signer: await createStaticSigningKeyProvider({ privateKeyPem }),
        google: new GoogleOAuthAuthenticator({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
        }),
        ...(config.allowedEmailDomain === undefined
          ? {}
          : { allowedEmailDomain: config.allowedEmailDomain }),
      },
    };
  } catch {
    throw signingKeyError();
  }
}

function decodeSigningKey(value: string): string {
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 0 || decoded.toString('base64') !== value) throw signingKeyError();
    const privateKeyPem = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    if (privateKeyPem.trim().length === 0) throw signingKeyError();
    return privateKeyPem;
  } catch {
    throw signingKeyError();
  }
}

function signingKeyError(): Error {
  return new Error(
    'self-host configuration: NOODLE_OAUTH_SIGNING_KEY_BASE64 must decode to a valid PKCS#8 PEM',
  );
}

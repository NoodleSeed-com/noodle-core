import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { resolveSelfHostConfig } from '../src/config.js';
import { ownerAuthOptions } from '../src/owner-auth.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ADMIN_TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const ASSET_IDENTITY_SALT = Buffer.alloc(32, 9).toString('base64url');
const PRIVATE_KEY_PEM = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;
const SIGNING_KEY_BASE64 = Buffer.from(PRIVATE_KEY_PEM, 'utf8').toString('base64');

function validEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://noodle:password@database:5432/noodle',
    NOODLE_SECRET_MASTER_KEY: MASTER_KEY,
    NOODLE_SELF_HOST_ADMIN_TOKEN: ADMIN_TOKEN,
    NOODLE_ASSET_ROOT: '/var/lib/noodle/assets',
    NOODLE_ASSET_IDENTITY_SALT: ASSET_IDENTITY_SALT,
  };
}

function configurationFailure(ownerAuthEnvironment: Readonly<Record<string, string>>): string {
  try {
    resolveSelfHostConfig({ ...validEnvironment(), ...ownerAuthEnvironment });
    throw new Error('configuration unexpectedly resolved');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function expectSecretAbsent(output: string, secret: string): void {
  expect(output.includes(secret)).toBe(false);
}

describe('ownerAuthOptions', () => {
  it('keeps public-only deployments free of owner authentication', async () => {
    const config = resolveSelfHostConfig(validEnvironment());

    expect(await ownerAuthOptions(config.ownerAuth)).toEqual({});
  });

  it('maps a complete external issuer to discovery and JWT verification', async () => {
    const config = resolveSelfHostConfig({
      ...validEnvironment(),
      NOODLE_OAUTH_ISSUER: 'https://idp.example.test',
      NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
    });

    const options = await ownerAuthOptions(config.ownerAuth);

    expect(Object.keys(options).sort()).toEqual(['authServerIssuer', 'verifyOwnerToken']);
    expect(options.authServerIssuer).toBe('https://idp.example.test');
    expect(await options.verifyOwnerToken?.('invalid-token')).toBeNull();
  });

  it('maps a complete Google group to the self-host authorization server with a stable signer', async () => {
    const config = resolveSelfHostConfig({
      ...validEnvironment(),
      NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
      NOODLE_OAUTH_SIGNING_KEY_BASE64: SIGNING_KEY_BASE64,
      NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
      NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
      NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN: '@example.test',
    });

    const options = await ownerAuthOptions(config.ownerAuth);
    const oauth = options.oauth;

    expect(Object.keys(options)).toEqual(['oauth']);
    expect(oauth?.issuer).toBe('https://noodle.example.test');
    expect(oauth?.allowedEmailDomain).toBe('@example.test');
    expect((await oauth?.signer.publicJwks())?.keys).toHaveLength(1);
    const authorizationUrl = oauth?.google?.authorizationUrl('state-token');
    expect(authorizationUrl?.searchParams.get('client_id')).toBe('google-client-id');
    expect(authorizationUrl?.searchParams.get('redirect_uri')).toBe(
      'https://noodle.example.test/oauth/google/callback',
    );
  });

  it.each([
    [
      'an external issuer without JWKS',
      { NOODLE_OAUTH_ISSUER: 'https://idp.example.test' },
      'NOODLE_OAUTH_JWKS_URI',
    ],
    [
      'Google federation without its stable signing key',
      {
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
      },
      'NOODLE_OAUTH_SIGNING_KEY_BASE64',
    ],
  ])('rejects %s without disclosing supplied values', (_description, environment, missingName) => {
    const suppliedSecret = Object.values(environment).at(-1) ?? '';
    const message = configurationFailure(environment);

    expect(message).toContain(missingName);
    expectSecretAbsent(message, suppliedSecret);
  });

  it('rejects mixed external and Google configuration', () => {
    const clientSecret = 'google-client-secret-that-must-not-leak';
    const message = configurationFailure({
      NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
      NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
      NOODLE_OAUTH_SIGNING_KEY_BASE64: SIGNING_KEY_BASE64,
      NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: clientSecret,
      NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
    });

    expect(message).toContain('NOODLE_OAUTH_JWKS_URI');
    expectSecretAbsent(message, clientSecret);
  });

  it.each([
    ['invalid base64', 'not-valid-base64!'],
    ['empty decoded text', ''],
    ['a non-PKCS#8 decoded value', Buffer.from('not a private key').toString('base64')],
  ])('rejects %s without disclosing the signing key', async (_description, signingKeyBase64) => {
    const environment = {
      ...validEnvironment(),
      NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
      NOODLE_OAUTH_SIGNING_KEY_BASE64: signingKeyBase64,
      NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
      NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
    };

    let message = '';
    try {
      const config = resolveSelfHostConfig(environment);
      await ownerAuthOptions(config.ownerAuth);
      throw new Error('invalid signing key unexpectedly accepted');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('NOODLE_OAUTH_SIGNING_KEY_BASE64');
    if (signingKeyBase64.length > 0) expectSecretAbsent(message, signingKeyBase64);
  });

  it.each([
    'NOODLE_OAUTH_WORKOS_CLIENT_ID',
    'NOODLE_OAUTH_WORKOS_API_KEY',
    'NOODLE_OAUTH_WORKOS_REALM',
    'NOODLE_OAUTH_WORKOS_AUTHENTICATION_METHODS',
  ])('rejects the commercial %s setting without disclosing it', (variableName) => {
    const secret = `${variableName.toLowerCase()}-must-not-leak`;
    const message = configurationFailure({ [variableName]: secret });

    expect(message).toContain(variableName);
    expectSecretAbsent(message, secret);
  });

  it.each([
    'NOODLE_OAUTH_CONSOLE_CLIENT_ID',
    'NOODLE_CONSOLE_URL',
    'RESEND_API_KEY',
    'NOODLE_KMS_KEY',
    'INSTANCE_CONNECTION_NAME',
    'DB_USER',
    'DB_NAME',
    'DB_IP_TYPE',
  ])('rejects the non-portable %s setting without disclosing it', (variableName) => {
    const secret = `${variableName.toLowerCase()}-must-not-leak`;
    const message = configurationFailure({ [variableName]: secret });

    expect(message).toContain(variableName);
    expectSecretAbsent(message, secret);
  });
});

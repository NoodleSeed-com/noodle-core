import { describe, expect, it } from 'vitest';

import { resolveSelfHostConfig } from '../src/config.js';

const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const ADMIN_TOKEN = 'LQPPSnvpT4TMomooI4tXegZQJQFxeEJr2Sn9sYrZj9Y';
const ASSET_IDENTITY_SALT = Buffer.alloc(32, 9).toString('base64url');

function validEnvironment(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://noodle:password@database:5432/noodle',
    NOODLE_SECRET_MASTER_KEY: MASTER_KEY,
    NOODLE_SELF_HOST_ADMIN_TOKEN: ADMIN_TOKEN,
    NOODLE_ASSET_ROOT: '/var/lib/noodle/assets',
    NOODLE_ASSET_IDENTITY_SALT: ASSET_IDENTITY_SALT,
  };
}

function expectConfigurationError(
  environment: Record<string, string>,
  variableName: string,
  suppliedValue: string,
): void {
  try {
    resolveSelfHostConfig(environment);
    throw new Error('configuration unexpectedly resolved');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toContain(variableName);
    expect(message).not.toContain(suppliedValue);
  }
}

describe('resolveSelfHostConfig', () => {
  it.each([
    ['DATABASE_URL', 'postgresql://noodle:password@database:5432/noodle'],
    ['NOODLE_SECRET_MASTER_KEY', MASTER_KEY],
    ['NOODLE_SELF_HOST_ADMIN_TOKEN', ADMIN_TOKEN],
    ['NOODLE_ASSET_ROOT', '/var/lib/noodle/assets'],
    ['NOODLE_ASSET_IDENTITY_SALT', ASSET_IDENTITY_SALT],
  ])('requires %s without disclosing its supplied value', (variableName, suppliedValue) => {
    const environment = validEnvironment();
    delete environment[variableName];

    expectConfigurationError(environment, variableName, suppliedValue);
  });

  it('uses the local-only host, port, and public origin defaults', () => {
    expect(resolveSelfHostConfig(validEnvironment())).toMatchObject({
      host: '0.0.0.0',
      port: 8787,
      publicBaseUrl: 'http://localhost:8787',
      assetRoot: '/var/lib/noodle/assets',
      assetIdentitySalt: ASSET_IDENTITY_SALT,
    });
  });

  it('accepts the non-sensitive build identity stamped into the public service image', () => {
    expect(() =>
      resolveSelfHostConfig({
        ...validEnvironment(),
        NOODLE_BUILD_VERSION: '0.35.0',
        NOODLE_BUILD_SHA: '0123456789abcdef0123456789abcdef01234567',
        NOODLE_BUILD_TIME: '2026-08-25T17:24:00Z',
      }),
    ).not.toThrow();
  });

  it('requires an absolute asset root without disclosing the supplied path', () => {
    const assetRoot = 'relative/private-assets';
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_ASSET_ROOT: assetRoot },
      'NOODLE_ASSET_ROOT',
      assetRoot,
    );
  });

  it('requires an exact canonical 32-byte base64url asset identity salt', () => {
    const salt = Buffer.alloc(31, 5).toString('base64url');
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_ASSET_IDENTITY_SALT: salt },
      'NOODLE_ASSET_IDENTITY_SALT',
      salt,
    );
  });

  it('normalizes PUBLIC_BASE_URL to its URL origin', () => {
    expect(
      resolveSelfHostConfig({
        ...validEnvironment(),
        PUBLIC_BASE_URL: 'https://self-host.example.test/',
      }).publicBaseUrl,
    ).toBe('https://self-host.example.test');
  });

  it.each(['0', '65536', '8787.5', 'not-a-port'])('rejects invalid PORT %s', (port) => {
    expectConfigurationError({ ...validEnvironment(), PORT: port }, 'PORT', port);
  });

  it('rejects an invalid PUBLIC_BASE_URL without disclosing it', () => {
    const publicBaseUrl = 'not a public URL';
    expectConfigurationError(
      { ...validEnvironment(), PUBLIC_BASE_URL: publicBaseUrl },
      'PUBLIC_BASE_URL',
      publicBaseUrl,
    );
  });

  it('requires NOODLE_SECRET_MASTER_KEY to decode to exactly 32 bytes', () => {
    const shortKey = Buffer.alloc(31, 2).toString('base64');
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_SECRET_MASTER_KEY: shortKey },
      'NOODLE_SECRET_MASTER_KEY',
      shortKey,
    );
  });

  it.each([
    ['a known example token', 'example-admin-token-do-not-use-123'],
    ['an all-one-character token', 'z'.repeat(32)],
    ['a leading-whitespace token', ` ${ADMIN_TOKEN}`],
    ['a trailing-whitespace token', `${ADMIN_TOKEN} `],
  ])('rejects %s without disclosing it', (_description, adminToken) => {
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_SELF_HOST_ADMIN_TOKEN: adminToken },
      'NOODLE_SELF_HOST_ADMIN_TOKEN',
      adminToken,
    );
  });

  it('accepts a complete external owner-auth group', () => {
    expect(
      resolveSelfHostConfig({
        ...validEnvironment(),
        NOODLE_OAUTH_ISSUER: 'https://idp.example.test',
        NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
      }).ownerAuth,
    ).toEqual({
      kind: 'external',
      issuer: 'https://idp.example.test',
      jwksUri: 'https://idp.example.test/.well-known/jwks.json',
    });
  });

  it.each([
    [
      'NOODLE_OAUTH_ISSUER',
      {
        NOODLE_OAUTH_ISSUER: 'http://idp.example.test',
        NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
      },
      'http://idp.example.test',
    ],
    [
      'NOODLE_OAUTH_JWKS_URI',
      {
        NOODLE_OAUTH_ISSUER: 'https://idp.example.test',
        NOODLE_OAUTH_JWKS_URI: 'http://keys.example.test/.well-known/jwks.json',
      },
      'http://keys.example.test/.well-known/jwks.json',
    ],
    [
      'NOODLE_OAUTH_GOOGLE_REDIRECT_URI',
      {
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_SIGNING_KEY_BASE64: Buffer.from('private-key-fixture').toString('base64'),
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'http://noodle.example.test/oauth/google/callback',
      },
      'http://noodle.example.test/oauth/google/callback',
    ],
    [
      'NOODLE_OAUTH_ISSUER',
      {
        NOODLE_OAUTH_ISSUER: 'http://auth.localhost:9000',
        NOODLE_OAUTH_JWKS_URI: 'https://auth.example.test/.well-known/jwks.json',
      },
      'http://auth.localhost:9000',
    ],
  ])('requires HTTPS for non-loopback %s without disclosing its value', (variableName, ownerAuth, value) => {
    expectConfigurationError({ ...validEnvironment(), ...ownerAuth }, variableName, value);
  });

  it.each([
    ['IPv4', 'http://127.0.0.1:9000', 'http://127.0.0.1:9000/.well-known/jwks.json'],
    ['IPv6', 'http://[::1]:9000', 'http://[::1]:9000/.well-known/jwks.json'],
    ['localhost', 'http://localhost:9000', 'http://localhost:9000/.well-known/jwks.json'],
  ])('allows explicit %s loopback HTTP for an external issuer and JWKS', (_kind, issuer, jwksUri) => {
    expect(
      resolveSelfHostConfig({
        ...validEnvironment(),
        NOODLE_OAUTH_ISSUER: issuer,
        NOODLE_OAUTH_JWKS_URI: jwksUri,
      }).ownerAuth,
    ).toEqual({ kind: 'external', issuer, jwksUri });
  });

  it('accepts a complete Google owner-auth group', () => {
    const signingKeyBase64 = Buffer.from(
      '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
    ).toString('base64');
    expect(
      resolveSelfHostConfig({
        ...validEnvironment(),
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_SIGNING_KEY_BASE64: signingKeyBase64,
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
        NOODLE_OAUTH_ALLOWED_EMAIL_DOMAIN: '@example.test',
      }).ownerAuth,
    ).toEqual({
      kind: 'google',
      issuer: 'https://noodle.example.test',
      signingKeyBase64,
      clientId: 'google-client-id',
      clientSecret: 'google-client-secret',
      redirectUri: 'https://noodle.example.test/oauth/google/callback',
      allowedEmailDomain: '@example.test',
    });
  });

  it.each([
    ['IPv4', 'http://127.0.0.1:9000'],
    ['IPv6', 'http://[::1]:9000'],
    ['localhost', 'http://localhost:9000'],
  ])('allows explicit %s loopback HTTP for Google issuer and redirect', (_kind, issuer) => {
    const redirectUri = `${issuer}/oauth/google/callback`;
    expect(
      resolveSelfHostConfig({
        ...validEnvironment(),
        NOODLE_OAUTH_ISSUER: issuer,
        NOODLE_OAUTH_SIGNING_KEY_BASE64: Buffer.from('private-key-fixture').toString('base64'),
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: 'google-client-secret',
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: redirectUri,
      }).ownerAuth,
    ).toMatchObject({ kind: 'google', issuer, redirectUri });
  });

  it.each([
    [
      'external',
      { NOODLE_OAUTH_ISSUER: 'https://idp.example.test' },
      'NOODLE_OAUTH_JWKS_URI',
      'https://idp.example.test',
    ],
    [
      'Google',
      {
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
      },
      'NOODLE_OAUTH_SIGNING_KEY_BASE64',
      'google-client-id',
    ],
  ])('rejects an incomplete %s owner-auth group', (_kind, ownerAuth, variableName, suppliedValue) => {
    expectConfigurationError({ ...validEnvironment(), ...ownerAuth }, variableName, suppliedValue);
  });

  it('rejects mutually exclusive external and Google owner-auth groups', () => {
    const clientSecret = 'google-client-secret';
    expectConfigurationError(
      {
        ...validEnvironment(),
        NOODLE_OAUTH_ISSUER: 'https://noodle.example.test',
        NOODLE_OAUTH_JWKS_URI: 'https://idp.example.test/.well-known/jwks.json',
        NOODLE_OAUTH_SIGNING_KEY_BASE64: Buffer.from(
          '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----',
        ).toString('base64'),
        NOODLE_OAUTH_GOOGLE_CLIENT_ID: 'google-client-id',
        NOODLE_OAUTH_GOOGLE_CLIENT_SECRET: clientSecret,
        NOODLE_OAUTH_GOOGLE_REDIRECT_URI: 'https://noodle.example.test/oauth/google/callback',
      },
      'NOODLE_OAUTH_JWKS_URI',
      clientSecret,
    );
  });

  it('rejects WorkOS variables without disclosing their value', () => {
    const workosApiKey = 'workos-secret';
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_OAUTH_WORKOS_API_KEY: workosApiKey },
      'NOODLE_OAUTH_WORKOS_API_KEY',
      workosApiKey,
    );
  });

  it('rejects unknown Noodle configuration instead of silently using a working default', () => {
    const unsupportedValue = 'unsupported-secret';
    expectConfigurationError(
      { ...validEnvironment(), NOODLE_SELF_HOST_UNSUPPORTED: unsupportedValue },
      'NOODLE_SELF_HOST_UNSUPPORTED',
      unsupportedValue,
    );
  });
});

import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as oauth from 'oauth4webapi';
import type { ConnectionProvider } from '../src/connections/oauth.js';

/** No actual provider account or network. OAuth processing and signature verification remain real. */
export async function oauthFixture(overrides: Partial<ConnectionProvider> = {}) {
  const keys = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { nonce: string; challenge: string; subject: string; scopes: string }
  >();
  let tokenCalls = 0;
  let refreshCalls = 0;
  let revoked = 0;
  let failRefresh = false;
  const provider: ConnectionProvider = {
    id: 'fixture',
    label: 'Fixture account',
    server: {
      issuer: 'https://issuer.example.test',
      authorization_endpoint: 'https://issuer.example.test/authorize',
      token_endpoint: 'https://issuer.example.test/token',
      jwks_uri: 'https://issuer.example.test/jwks',
      revocation_endpoint: 'https://issuer.example.test/revoke',
    },
    clientId: 'fixture-client',
    clientSecret: 'fixture-client-secret',
    redirectUri: 'https://portal.example.test/api/connections/callback',
    scopes: ['openid', 'records.read', 'records.write'],
    allowedOrigins: ['https://issuer.example.test'],
    ...overrides,
  };
  return {
    provider,
    metrics: () => ({ tokenCalls, refreshCalls, revoked }),
    failRefresh: () => {
      failRefresh = true;
    },
    authorize(authorizationUrl: string, subject = 'account-one', scopes?: string) {
      const url = new URL(authorizationUrl);
      const code = randomUUID();
      codes.set(code, {
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        subject,
        scopes: scopes ?? url.searchParams.get('scope') ?? '',
      });
      return { code, state: url.searchParams.get('state') ?? '' };
    },
    fetch: async (url: URL, init: RequestInit = {}) => {
      if (url.href === provider.server.jwks_uri) return Response.json({ keys: [jwk] });
      const body = new URLSearchParams(String(init.body));
      if (url.href === provider.server.revocation_endpoint) {
        revoked++;
        return Response.json({});
      }
      if (
        url.href !== provider.server.token_endpoint ||
        body.get('client_secret') !== provider.clientSecret
      )
        return Response.json({ error: 'invalid_client' }, { status: 401 });
      if (body.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        if (failRefresh) throw new Error('simulated response loss');
        return Response.json({
          access_token: 'fresh-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: provider.scopes.join(' '),
        });
      }
      tokenCalls++;
      const code = body.get('code') ?? '';
      const accepted = codes.get(code);
      codes.delete(code);
      if (
        !accepted ||
        (await oauth.calculatePKCECodeChallenge(body.get('code_verifier') ?? '')) !==
          accepted.challenge
      )
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const idToken = await new SignJWT({ nonce: accepted.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(provider.server.issuer)
        .setAudience(provider.clientId)
        .setSubject(accepted.subject)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(keys.privateKey);
      return Response.json({
        access_token: 'fixture-access-token',
        refresh_token: 'fixture-refresh-token',
        token_type: 'Bearer',
        expires_in: 60,
        scope: accepted.scopes,
        id_token: idToken,
      });
    },
  };
}

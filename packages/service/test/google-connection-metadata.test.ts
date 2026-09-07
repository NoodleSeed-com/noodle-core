import { describe, expect, it } from 'vitest';
import { PortableConnections } from '../src/connections/service.js';
import { InMemoryConnectionStore } from '../src/connections/store.js';
import { oauthFixture } from './connection-oauth-fixture.js';

// Public metadata verified 2026-09-07 at https://accounts.google.com/.well-known/openid-configuration.
// Only provider HTTP is simulated; the actual OAuth library checks state, PKCE, issuer, nonce and signature.
const server = {
  issuer: 'https://accounts.google.com',
  authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_endpoint: 'https://oauth2.googleapis.com/token',
  jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
  revocation_endpoint: 'https://oauth2.googleapis.com/revoke',
  authorization_response_iss_parameter_supported: true,
  code_challenge_methods_supported: ['plain', 'S256'],
  id_token_signing_alg_values_supported: ['RS256'],
};
const scopes = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.events.freebusy',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const target = {
  key: {
    org: 'one',
    app: 'app',
    env: 'prod',
    installationId: 'one',
    connectionId: 'google_calendar_account',
  },
  label: 'Calendar',
  connectionConfigRevision: 'one',
  requiredScopes: scopes,
};
const sessionBinding = 's'.repeat(43);
describe('Google advertised authorization response issuer', () => {
  it.each([
    server.issuer,
    undefined,
    'https://different.example',
  ])('validates callback issuer %s before token exchange', async (iss) => {
    const provider = await oauthFixture({
      server,
      scopes,
      allowedOrigins: [
        'https://accounts.google.com',
        'https://oauth2.googleapis.com',
        'https://www.googleapis.com',
      ],
    });
    const service = new PortableConnections({
      store: new InMemoryConnectionStore(),
      providers: async () => provider.provider,
      resolveTarget: async () => target,
      authorize: async () => true,
      credentialEpoch: 'google-contract-test-01',
      portalOrigins: ['https://portal.example.test'],
      guardedFetch: provider.fetch,
    });
    const started = await service.connect(
      target,
      {
        expectedRevision: 0,
        returnUrl: 'https://portal.example.test/o/one/app/integrations',
        sessionBinding,
      },
      'owner',
    );
    const input = {
      ...provider.authorize(started.authorizationUrl),
      sessionBinding,
      ...(iss === undefined ? {} : { iss }),
    };
    if (iss === server.issuer) {
      await service.callback(input, 'owner');
      expect((await service.inspect(target)).state).toBe('ready');
      expect(provider.metrics().tokenCalls).toBe(1);
    } else {
      await expect(service.callback(input, 'owner')).rejects.toThrow('connection_unavailable');
      expect(provider.metrics().tokenCalls).toBe(0);
      expect((await service.inspect(target)).state).toBe('unconfigured');
    }
    await expect(service.callback(input, 'owner')).rejects.toThrow('connection_invalid');
  });
});

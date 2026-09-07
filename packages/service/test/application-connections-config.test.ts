import { describe, expect, it } from 'vitest';
import { resolveApplicationConnectionsConfig } from '../src/application-connections-config.js';

const provider = {
  id: 'example',
  label: 'Example account',
  clientId: 'client',
  clientSecret: 'test-private-value',
  server: {
    issuer: 'https://id.example.test',
    authorization_endpoint: 'https://id.example.test/authorize',
    token_endpoint: 'https://id.example.test/token',
    jwks_uri: 'https://id.example.test/jwks',
  },
  redirectUri: 'https://portal.example.test/api/connections/callback',
  scopes: ['openid', 'records:write'],
  allowedOrigins: ['https://id.example.test'],
};
const config = {
  NOODLE_CONNECTION_PROVIDERS: JSON.stringify({ example: provider }),
  NOODLE_CONNECTION_CREDENTIAL_EPOCH: 'test-credential-epoch-01',
  NOODLE_PORTAL_URL: 'https://portal.example.test',
};
describe('operator connection host configuration', () => {
  it('is opt-in and resolves only deployment-registered connection identifiers', async () => {
    expect(resolveApplicationConnectionsConfig({})).toBeUndefined();
    const resolved = resolveApplicationConnectionsConfig(config);
    const scope = { org: 'a', app: 'b', env: 'prod', installationId: 'c' };
    expect(await resolved?.providers({ ...scope, connectionId: 'example' })).toEqual(provider);
    expect(await resolved?.providers({ ...scope, connectionId: 'unregistered' })).toBeUndefined();
    expect(resolved?.credentialEpoch).toBe(config.NOODLE_CONNECTION_CREDENTIAL_EPOCH);
  });
  it.each([undefined, ''])('disables an absent provider registration with epoch %j', (epoch) => {
    expect(
      resolveApplicationConnectionsConfig({ NOODLE_CONNECTION_CREDENTIAL_EPOCH: epoch }),
    ).toBeUndefined();
    expect(
      resolveApplicationConnectionsConfig({
        NOODLE_CONNECTION_CREDENTIAL_EPOCH: epoch,
        NOODLE_PORTAL_URL: config.NOODLE_PORTAL_URL,
      }),
    ).toBeUndefined();
  });
  it.each([
    { ...config, NOODLE_CONNECTION_CREDENTIAL_EPOCH: undefined },
    { ...config, NOODLE_CONNECTION_CREDENTIAL_EPOCH: '' },
    { ...config, NOODLE_CONNECTION_CREDENTIAL_EPOCH: ' ' },
    { ...config, NOODLE_CONNECTION_PROVIDERS: undefined },
    { NOODLE_CONNECTION_CREDENTIAL_EPOCH: ' ' },
    { NOODLE_CONNECTION_PROVIDERS: '' },
    { NOODLE_CONNECTION_PROVIDERS: '', NOODLE_CONNECTION_CREDENTIAL_EPOCH: '' },
    { NOODLE_CONNECTION_PROVIDERS: ' ', NOODLE_CONNECTION_CREDENTIAL_EPOCH: '' },
    {
      NOODLE_CONNECTION_PROVIDERS: '{test-private-value',
      NOODLE_CONNECTION_CREDENTIAL_EPOCH: '',
    },
    { ...config, NOODLE_PORTAL_URL: undefined },
    { ...config, NOODLE_PORTAL_URL: 'https://portal.example.test/path' },
    { ...config, NOODLE_CONNECTION_PROVIDERS: '{test-private-value' },
    {
      ...config,
      NOODLE_CONNECTION_PROVIDERS: JSON.stringify({
        example: { ...provider, redirectUri: 'https://other.test/api/connections/callback' },
      }),
    },
    {
      ...config,
      NOODLE_CONNECTION_PROVIDERS: JSON.stringify({
        example: {
          ...provider,
          server: { ...provider.server, token_endpoint: 'https://unregistered.test/token' },
        },
      }),
    },
    {
      ...config,
      NOODLE_CONNECTION_PROVIDERS: JSON.stringify({
        example: { ...provider, authorizationParameters: { redirect_uri: 'https://other.test' } },
      }),
    },
    {
      ...config,
      NOODLE_CONNECTION_PROVIDERS: JSON.stringify({
        example: { ...provider, extra: 'test-private-value' },
      }),
    },
  ])('fails closed before bind without leaking private configuration', (env) => {
    expect(() => resolveApplicationConnectionsConfig(env)).toThrow(
      'Application connection host configuration is invalid',
    );
    try {
      resolveApplicationConnectionsConfig(env);
    } catch (error) {
      expect(String(error)).not.toContain('test-private-value');
    }
  });
});

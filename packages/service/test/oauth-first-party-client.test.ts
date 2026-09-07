import { describe, expect, it } from 'vitest';
import {
  reconcileConfiguredFirstPartyOAuthClients,
  reconcileFirstPartyOAuthClient,
  resolveFirstPartyOAuthClient,
} from '../src/oauth/first-party-client.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';

const INPUT = {
  owner: 'console',
  clientId: 'noodle-console-v1',
  redirectUri: 'https://console.noodleseed.dev/api/console/auth/callback',
  resource: 'https://cloud.noodleseed.dev',
} as const;

describe('first-party Console OAuth client', () => {
  it('reconciles one exact public PKCE client and is idempotent', async () => {
    const store = new InMemoryOAuthStore();
    const expected = resolveFirstPartyOAuthClient(INPUT);

    await expect(reconcileFirstPartyOAuthClient(store, INPUT)).resolves.toEqual(expected);
    await expect(reconcileFirstPartyOAuthClient(store, INPUT)).resolves.toEqual(expected);
    await expect(store.getClient(INPUT.clientId)).resolves.toEqual({
      client_id: INPUT.clientId,
      client_name: 'Noodle Console',
      application_type: 'web',
      redirect_uris: [INPUT.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      default_resource: `${INPUT.resource}/`,
    });
  });

  it('fails closed when the reserved ID already belongs to a DCR client', async () => {
    const store = new InMemoryOAuthStore();
    const dcr = {
      client_id: 'existing-dcr-client',
      redirect_uris: ['https://mcp-client.test/callback'],
      token_endpoint_auth_method: 'none',
    } as const;
    await store.putClient(dcr);
    await store.putClient({
      client_id: INPUT.clientId,
      redirect_uris: ['https://attacker.test/callback'],
      token_endpoint_auth_method: 'none',
    });

    await expect(reconcileFirstPartyOAuthClient(store, INPUT)).rejects.toThrow(
      /already registered/i,
    );

    await expect(store.getClient(dcr.client_id)).resolves.toEqual(dcr);
    await expect(store.getClient(INPUT.clientId)).resolves.toEqual({
      client_id: INPUT.clientId,
      redirect_uris: ['https://attacker.test/callback'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('does not let a later dynamic registration overwrite the reserved Console client', async () => {
    const store = new InMemoryOAuthStore();
    await reconcileFirstPartyOAuthClient(store, INPUT);

    await expect(
      store.putClient({
        client_id: INPUT.clientId,
        redirect_uris: ['https://attacker.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    ).rejects.toThrow(/reserved/i);
    await expect(store.getClient(INPUT.clientId)).resolves.toEqual(
      resolveFirstPartyOAuthClient(INPUT),
    );
  });

  it.each([
    { ...INPUT, clientId: '' },
    { ...INPUT, clientId: 'has spaces' },
    { ...INPUT, redirectUri: 'http://console.example/api/console/auth/callback' },
    { ...INPUT, redirectUri: 'https://console.example/wrong' },
    { ...INPUT, redirectUri: 'https://user@console.example/api/console/auth/callback' },
    { ...INPUT, resource: 'http://cloud.example' },
    { ...INPUT, resource: 'https://cloud.example/path' },
  ])('rejects an unsafe or partial client contract: %o', (input) => {
    expect(() => resolveFirstPartyOAuthClient(input)).toThrow(/Noodle Console OAuth client/);
  });

  it('allows loopback HTTP only for local Console development', () => {
    expect(
      resolveFirstPartyOAuthClient({
        owner: 'console',
        clientId: 'local-console',
        redirectUri: 'http://127.0.0.1:3000/api/console/auth/callback',
        resource: 'http://127.0.0.1:8787',
      }),
    ).toMatchObject({ client_id: 'local-console' });
  });

  it('reserves a separate Portal client with its exact callback', async () => {
    const store = new InMemoryOAuthStore();
    const portal = {
      owner: 'portal' as const,
      clientId: 'noodle-portal-v1',
      redirectUri: 'https://business.noodleseed.dev/api/portal/auth/callback',
      resource: INPUT.resource,
    };
    await expect(reconcileFirstPartyOAuthClient(store, portal)).resolves.toMatchObject({
      client_id: portal.clientId,
      client_name: 'Noodle Business Portal',
      redirect_uris: [portal.redirectUri],
    });
    await expect(store.getClient(INPUT.clientId)).resolves.toBeUndefined();
  });

  it('reconciles Console and Portal configuration together', async () => {
    const store = new InMemoryOAuthStore();
    await reconcileConfiguredFirstPartyOAuthClients(
      store,
      {
        console: { clientId: INPUT.clientId, redirectUri: INPUT.redirectUri },
        portal: {
          clientId: 'noodle-portal-v1',
          redirectUri: 'https://business.noodleseed.dev/api/portal/auth/callback',
        },
      },
      INPUT.resource,
    );
    await expect(store.getClient(INPUT.clientId)).resolves.toBeDefined();
    await expect(store.getClient('noodle-portal-v1')).resolves.toBeDefined();
  });
});

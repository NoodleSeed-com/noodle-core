import type { IncomingMessage } from 'node:http';
import { InMemoryControlPlaneStore } from '@noodle-borg/control-plane/portable';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { restrictPortalControlPlane } from '../src/auth/portal-control-plane-policy.js';
import { createDefaultControlPlaneGate } from '../src/control-plane-auth-bootstrap.js';
import { reconcileFirstPartyOAuthClient } from '../src/oauth/first-party-client.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';

const resource = 'https://service.example';
const base = '/v1/orgs/acme/solution-installations/installed';
const authorized = [
  ['GET', '/v1/whoami'],
  ['GET', '/v1/whoami?scope=identity'],
  ['GET', '/v1/me/solution-installations'],
  ['GET', '/v1/me/solution-installation-options'],
  ['GET', '/v1/solutions/catalog'],
  ['GET', '/v1/orgs/acme/billing'],
  ['GET', '/v1/orgs/acme/agreement'],
  ['POST', '/v1/orgs/acme/agreement'],
  ['POST', '/v1/orgs/acme/solution-installations'],
  ['GET', '/v1/orgs/acme/solution-installations'],
  ['GET', base],
  ['PATCH', base],
  ['GET', `${base}/settings`],
  ['PATCH', `${base}/settings`],
  ['GET', `${base}/notice`],
  ['PUT', `${base}/notice`],
  ['PATCH', `${base}/channels`],
  ['GET', `${base}/activity`],
  ['GET', `${base}/activity/export`],
  ['GET', `${base}/activity/preview`],
  ['PATCH', `${base}/activity/settings`],
  ['POST', `${base}/grants`],
  ['DELETE', `${base}/grants/staff`],
  ['POST', `${base}/invitations`],
  ['DELETE', `${base}/invitations/invite`],
  ['POST', '/v1/solution-invitations/token/accept'],
  ['GET', `${base}/assignees`],
  ['GET', `${base}/connections`],
  ['POST', `${base}/connections/calendar/connect`],
  ['POST', `${base}/connections/calendar/disconnect`],
  ['POST', '/v1/solution-connections/callback'],
  ['POST', `${base}/collections/items/records`],
  ['PATCH', `${base}/collections/items/records/record`],
  ['DELETE', `${base}/collections/items/records/record`],
  ['GET', `${base}/collections/items/records/record/activity`],
  ['GET', `${base}/collections/items/records/export`],
  ['PATCH', `${base}/collections/items/source`],
  ['POST', `${base}/collections/items/source/refresh`],
] as const;
const denied = [
  ['POST', '/v1/orgs/acme/apps/demo/envs/prod/deploy'],
  ['GET', '/v1/solution-connections/callback'],
  ['PATCH', '/v1/solution-connections/callback'],
  ['POST', '/v1/solution-connections/callback/extra'],
  ['GET', '/v1/orgs/acme/apps'],
  ['GET', '/v1/orgs/acme/apps/demo/envs/prod/secrets'],
  ['PUT', '/v1/orgs/acme/variables/KEY'],
  ['GET', '/v1/orgs/acme/members'],
  ['POST', '/v1/orgs/acme/invites'],
  ['POST', '/v1/orgs'],
  ['POST', '/v1/orgs/acme/billing'],
  ['GET', '/v1/orgs/acme/billing/invoices'],
  ['POST', '/v1/platform-auth/account-reset/quarantine'],
  ['POST', '/v1/service/business-information-reader-floor'],
  ['POST', '/v1/service/app-purge-reconciliation/apply'],
  ['GET', '/developer/cli'],
  ['GET', `${base}/settings/settings`],
  ['POST', `${base}/secrets`],
  ['GET', `${base}/collections/items/records/record/secrets`],
  ['DELETE', `${base}/notice`],
  ['PATCH', `${base}/activity/export`],
  ['POST', `${base}/activity/preview`],
  ['GET', '/v1/orgs/acme/solution-installations/../../apps'],
] as const;
function request(method: string, url: string, token = 'portal') {
  return {
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      'x-oauth-client-id': 'console',
      'x-client-name': 'Noodle Console',
    },
  } as unknown as IncomingMessage;
}

describe('verified Portal control-plane purpose ceiling', () => {
  let store: InMemoryOAuthStore;
  beforeEach(async () => {
    store = new InMemoryOAuthStore();
    for (const clientId of ['portal', 'retired-portal'])
      await reconcileFirstPartyOAuthClient(store, {
        owner: 'portal',
        clientId,
        resource,
        redirectUri: 'https://portal.example/api/portal/auth/callback',
      });
    await reconcileFirstPartyOAuthClient(store, {
      owner: 'console',
      clientId: 'console',
      resource,
      redirectUri: 'https://console.example/api/console/auth/callback',
    });
    await store.putClient({
      client_id: 'dcr',
      client_name: 'Noodle Business Portal',
      redirect_uris: ['https://other.example/callback'],
    });
  });
  function gate() {
    const google = vi.fn().mockResolvedValue({ subject: 'owner', email: 'owner@example.com' });
    const result = createDefaultControlPlaneGate({
      options: {
        publicBaseUrl: resource,
        controlPlaneSignupMode: 'public',
        controlPlaneAdmins: ['owner'],
        googleClientId: 'fixture',
        googleVerifier: { verify: google },
      },
      authServerIssuer: resource,
      controlPlaneStore: new InMemoryControlPlaneStore(),
      oauthStore: store,
      verifyOwnerToken: async (token, audience) =>
        audience !== `${resource}/` || token === 'invalid'
          ? null
          : {
              caller: {
                subject: 'owner',
                email: 'owner@example.com',
                ...(token === 'legacy'
                  ? {}
                  : { oauthClientId: token === 'portal-grant' ? 'portal' : token }),
                ...(token === 'portal-grant' ? { developerGrantId: 'grant' } : {}),
              },
            },
    });
    if (!result) throw new Error('Missing gate');
    return { result, google };
  }
  it.each(
    authorized,
  )('admits %s %s only to its ordinary live business authorization', async (method, path) => {
    expect(await gate().result.authorize(request(method, path))).toMatchObject({ ok: true });
  });
  it.each(
    denied,
  )('denies technical/undeclared operation %s %s even for a super-admin', async (method, path) => {
    const { result, google } = gate();
    expect(await result.authorize(request(method, path))).toMatchObject({ ok: false, status: 403 });
    expect(google).not.toHaveBeenCalled();
  });
  it.each(['retired-portal', 'portal-grant'])('preserves the ceiling for %s', async (token) => {
    expect(await gate().result.authorize(request('POST', denied[0][1], token))).toMatchObject({
      ok: false,
      status: 403,
    });
  });
  it.each([
    'console',
    'dcr',
    'legacy',
  ])('preserves separately authorized %s credentials, ignoring forged names/headers', async (token) => {
    expect(await gate().result.authorize(request('POST', denied[0][1], token))).toMatchObject({
      ok: true,
    });
  });
  it('recognizes only the exact configured confidential exchange with its developer grant', async () => {
    const identity = {
      subject: 'owner',
      email: 'owner@example.com',
      superAdmin: false,
      oauthClientId: 'exchange',
      developerGrantId: 'grant',
    };
    const authorizedGate = { authorize: () => ({ ok: true as const, identity }) };
    const input = request('POST', denied[0][1]);
    expect(
      await restrictPortalControlPlane(authorizedGate, store, 'exchange').authorize(input),
    ).toMatchObject({ ok: true });
    expect(
      await restrictPortalControlPlane(authorizedGate, store, 'other').authorize(input),
    ).toMatchObject({ ok: false, status: 403 });
    const portal = {
      authorize: () => ({ ok: true as const, identity: { ...identity, oauthClientId: 'portal' } }),
    };
    expect(
      await restrictPortalControlPlane(portal, store, 'portal').authorize(input),
    ).toMatchObject({ ok: false, status: 403 });
  });
  it('denies signed client-bearing tokens whose durable registration is missing or unavailable', async () => {
    expect(
      await gate().result.authorize(request('GET', '/v1/whoami', 'deleted-client')),
    ).toMatchObject({ ok: false, status: 403 });
    vi.spyOn(store, 'getClientPurpose').mockRejectedValue(new Error('private storage error'));
    expect(await gate().result.authorize(request('GET', '/v1/whoami'))).toEqual({
      ok: false,
      status: 403,
      message: 'OAuth client authorization is unavailable',
    });
  });
});

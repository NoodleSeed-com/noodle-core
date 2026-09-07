import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOAuthApp } from '../src/oauth/app.js';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { DeveloperGrantAuthorizer } from '../src/oauth/developer-grant-authorizer.js';
import type { GoogleAuthenticator } from '../src/oauth/google.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { hashToken } from '../src/oauth/tokens.js';
import { form, pkce, type RawResponse, raw } from './oauth-http-test-helpers.js';

const ISSUER = 'https://as.noodle.test';
const REDIRECT = 'https://chatgpt.com/connector/oauth/callback';
const OWNER_SUBJECT = 'google-owner-sub';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

let http: Server;
let base: string;
let signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
let developerGrants: InMemoryDeveloperGrantStore;
let oauthStore: InMemoryOAuthStore;
let provider: NoodleOAuthProvider;

beforeEach(async () => {
  signer = await createStaticSigningKeyProvider();
  developerGrants = new InMemoryDeveloperGrantStore();
  oauthStore = new InMemoryOAuthStore();
  const google: GoogleAuthenticator = {
    authorizationUrl: (state) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
  };
  provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: oauthStore,
    signer,
    google,
    developerGrantAuthorizer: new DeveloperGrantAuthorizer({ grants: developerGrants }),
  });
  http = createServer(createOAuthApp(provider));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('developer-resource OAuth', () => {
  it('keeps compact developer consent in the RFC 8628 device flow', async () => {
    const resource = `${ISSUER}/developer/cli`;
    const clientId = await registerDeviceClient();
    const started = await raw(
      'POST',
      `${base}/device_authorization`,
      form({ client_id: clientId, resource, scope: 'openid email' }),
    );
    const device = JSON.parse(started.text) as { device_code: string; user_code: string };
    const verification = await raw('POST', `${base}/device`, form({ user_code: device.user_code }));
    const authorize = new URL(verification.headers.location as string);
    const google = await raw('GET', `${base}${authorize.pathname}${authorize.search}`);
    const nonce = new URL(google.headers.location as string).searchParams.get('state');
    const selection = await raw(
      'GET',
      `${base}/oauth/google/callback?code=g-code&state=${encodeURIComponent(nonce as string)}`,
    );
    expect(selection.status).toBe(200);
    expect(selection.text).toContain('name="grant_token"');
    expect(selection.text).not.toContain('name="org"');
    expect(selection.text).not.toContain('name="environment"');
    const grantToken = /name="grant_token" value="([^"]+)"/.exec(selection.text)?.[1];
    const approved = await raw(
      'POST',
      `${base}/oauth/developer-grant`,
      form({
        grant_token: grantToken as string,
        decision: 'approve',
      }),
    );
    const callback = new URL(approved.headers.location as string);
    const completed = await raw('GET', `${base}${callback.pathname}${callback.search}`);
    expect(completed.status).toBe(200);
    const token = await raw(
      'POST',
      `${base}/token`,
      form({
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
        client_id: clientId,
        resource,
      }),
    );
    expect(token.status).toBe(200);
    const identity = await createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    })(JSON.parse(token.text).access_token, resource);
    expect(identity).toMatchObject({ caller: { oauthClientId: clientId } });
    await expect(
      developerGrants.get(identity?.caller.developerGrantId as string),
    ).resolves.toMatchObject({
      version: 2,
      clientId,
      subject: OWNER_SUBJECT,
      resource,
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'config:write', 'deployments:write'],
    });
  });

  it('revokes the bound developer grant through the standard OAuth revocation endpoint', async () => {
    const resource = `${ISSUER}/developer/cli`;
    const clientId = await registerClient();
    const client = await oauthStore.getClient(clientId);
    if (client === undefined) throw new Error('registered client missing');
    const grant = await developerGrants.getOrCreateActive({
      clientId,
      subject: OWNER_SUBJECT,
      resource,
      capabilities: ['cloud:read', 'config:write', 'deployments:write'],
    });
    await oauthStore.createAuthorizationCode({
      code: hashToken('revocable-code'),
      clientId,
      codeChallenge: 'challenge',
      redirectUri: REDIRECT,
      resource,
      ownerSubject: OWNER_SUBJECT,
      ownerEmail: 'owner@noodleseed.com',
      developerGrantId: grant.id,
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });
    const issued = await provider.exchangeAuthorizationCode(
      client,
      'revocable-code',
      undefined,
      REDIRECT,
      new URL(resource),
    );

    const revoked = await raw(
      'POST',
      `${base}/revoke`,
      form({ client_id: clientId, token: issued.access_token, token_type_hint: 'access_token' }),
    );

    expect(revoked.status).toBe(200);
    await expect(developerGrants.get(grant.id)).resolves.toMatchObject({
      id: grant.id,
      revokedAt: expect.any(String),
    });
  });

  it('preserves a grant-bound client identity through two refresh rotations', async () => {
    const resource = `${ISSUER}/developer/mcp`;
    const clientId = 'developer-client';
    const client = {
      client_id: clientId,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    } as OAuthClientInformationFull;
    await oauthStore.createAuthorizationCode({
      code: hashToken('developer-code'),
      clientId,
      codeChallenge: 'challenge',
      redirectUri: REDIRECT,
      resource,
      ownerSubject: OWNER_SUBJECT,
      ownerEmail: 'owner@noodleseed.com',
      developerGrantId: 'grant-1',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    });

    const issued = await provider.exchangeAuthorizationCode(
      client,
      'developer-code',
      undefined,
      REDIRECT,
      new URL(resource),
    );
    expect(issued).not.toHaveProperty('developerGrantId');
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await signer.verifierKey() });
    await expect(verify(issued.access_token, resource)).resolves.toMatchObject({
      caller: {
        developerGrantId: 'grant-1',
        oauthClientId: clientId,
      },
    });

    const firstRefresh = await provider.exchangeRefreshToken(
      client,
      issued.refresh_token as string,
      undefined,
      new URL(resource),
    );
    const secondRefresh = await provider.exchangeRefreshToken(
      client,
      firstRefresh.refresh_token as string,
      undefined,
      new URL(resource),
    );
    for (const tokens of [firstRefresh, secondRefresh]) {
      await expect(verify(tokens.access_token, resource)).resolves.toMatchObject({
        caller: {
          developerGrantId: 'grant-1',
          oauthClientId: clientId,
        },
      });
    }
  });

  it('binds live access once and skips consent for the same active tuple', async () => {
    const resource = `${ISSUER}/developer/mcp`;
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const selection = await runToSelection(clientId, challenge, resource);

    expect(selection.callback.status).toBe(200);
    expect(selection.callback.text).not.toContain('name="org"');
    expect(selection.callback.text).not.toContain('name="environment"');
    expect(selection.callback.text).toContain('Roll back deployments');
    expect(selection.callback.text).not.toContain('name="consent_token"');

    const approved = await raw('POST', `${base}/oauth/developer-grant`, {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_token: selection.grantToken,
        decision: 'approve',
      }).toString(),
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.location as string).searchParams.get('code') as string;
    const token = await exchangeCode(clientId, code, verifier, resource);
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.text);
    expect(tokens).not.toHaveProperty('developerGrantId');
    const verify = createJwtVerifier({ issuer: ISSUER, keyResolver: await signer.verifierKey() });
    const identity = await verify(tokens.access_token, resource);
    expect(identity).toMatchObject({ caller: { oauthClientId: clientId } });
    expect(identity?.caller.developerGrantId).toBeTruthy();
    await expect(
      developerGrants.get(identity?.caller.developerGrantId as string),
    ).resolves.toMatchObject({
      version: 2,
      clientId,
      subject: OWNER_SUBJECT,
      resource,
      accessModel: 'live_user',
      capabilities: ['cloud:read', 'deployments:rollback'],
    });

    const second = await runToCallback(clientId, pkce().challenge, resource);
    expect(second.status).toBe(302);
    expect(new URL(second.headers.location as string).searchParams.get('code')).toBeTruthy();
    expect(second.text).not.toContain('name="grant_token"');
  });

  it('rejects injected organization, environment, and capability fields before issuing a code', async () => {
    const resource = `${ISSUER}/developer/cli`;
    const clientId = await registerClient();
    const { grantToken } = await runToSelection(clientId, pkce().challenge, resource);
    const post = (body: string) =>
      raw('POST', `${base}/oauth/developer-grant`, {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
    const encoded = (fields: Readonly<Record<string, string>>) =>
      new URLSearchParams({ grant_token: grantToken, decision: 'approve', ...fields }).toString();

    for (const fields of [
      { org: 'other' },
      { environment: 'dev' },
      { capability: 'deployments:rollback' },
    ]) {
      await expect(post(encoded(fields))).resolves.toMatchObject({ status: 400 });
    }
  });

  it('requires compact consent again after the active grant is revoked', async () => {
    const resource = `${ISSUER}/developer/mcp`;
    const clientId = await registerClient();
    const first = await runToSelection(clientId, pkce().challenge, resource);
    const approved = await raw(
      'POST',
      `${base}/oauth/developer-grant`,
      form({ grant_token: first.grantToken, decision: 'approve' }),
    );
    const code = new URL(approved.headers.location as string).searchParams.get('code') as string;
    const grant = await developerGrants.getActive({ clientId, subject: OWNER_SUBJECT, resource });
    if (grant === undefined) throw new Error('expected active developer grant');
    await developerGrants.revoke(grant.id, new Date().toISOString());

    const reconnect = await runToCallback(clientId, pkce().challenge, resource);

    expect(code).toBeTruthy();
    expect(reconnect.status).toBe(200);
    expect(reconnect.text).toContain('name="grant_token"');
  });

  it('treats a developer path on another origin as ordinary generic consent', async () => {
    const clientId = await registerClient();
    const callback = await runToCallback(
      clientId,
      pkce().challenge,
      'https://untrusted.example/developer/mcp',
    );
    expect(callback.status).toBe(200);
    expect(callback.text).toContain('name="consent_token"');
    expect(callback.text).not.toContain('name="grant_token"');
  });

  it('requires an exact developer resource without query or fragment state', async () => {
    const clientId = await registerClient();
    const callback = await runToCallback(
      clientId,
      pkce().challenge,
      `${ISSUER}/developer/mcp?unexpected=scope`,
    );
    expect(callback.status).toBe(200);
    expect(callback.text).toContain('name="consent_token"');
    expect(callback.text).not.toContain('name="grant_token"');
  });
});

async function registerClient(): Promise<string> {
  const response = await raw('POST', `${base}/register`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Noodle Developer Plugin',
      application_type: 'web',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return JSON.parse(response.text).client_id as string;
}

async function registerDeviceClient(): Promise<string> {
  const response = await raw('POST', `${base}/register`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Noodle CLI',
      application_type: 'native',
      redirect_uris: [`${ISSUER}/oauth/device/callback`],
      token_endpoint_auth_method: 'none',
      grant_types: [DEVICE_GRANT, 'authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(response.status).toBe(201);
  return JSON.parse(response.text).client_id as string;
}

async function runToSelection(
  clientId: string,
  challenge: string,
  resource: string,
): Promise<{ callback: RawResponse; grantToken: string }> {
  const callback = await runToCallback(clientId, challenge, resource);
  const grantToken = /name="grant_token" value="([^"]+)"/.exec(callback.text)?.[1];
  expect(grantToken).toBeTruthy();
  return { callback, grantToken: grantToken as string };
}

async function runToCallback(
  clientId: string,
  challenge: string,
  resource: string,
): Promise<RawResponse> {
  const authorize = await raw(
    'GET',
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=developer-state&resource=${encodeURIComponent(resource)}`,
  );
  expect(authorize.status).toBe(302);
  const nonce = new URL(authorize.headers.location as string).searchParams.get('state') as string;
  return raw('GET', `${base}/oauth/google/callback?code=g-code&state=${encodeURIComponent(nonce)}`);
}

function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
): Promise<RawResponse> {
  return raw(
    'POST',
    `${base}/token`,
    form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource,
    }),
  );
}

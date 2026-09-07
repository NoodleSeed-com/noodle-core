import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createJwtVerifier,
  createStaticSigningKeyProvider,
  mintAccessToken,
} from '@noodle-borg/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryControlPlaneStore,
  ServerRegistry,
} from '../src/index.js';
import { createOAuthApp } from '../src/oauth/app.js';
import type { GoogleAuthenticator } from '../src/oauth/google.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { buildCustomerBridgeServer } from './oauth-customer-bridge-fixture.js';
import { form, mcpInit, pkce, type RawResponse, raw } from './oauth-http-test-helpers.js';

const HELLO = `
manifestVersion: "1"
server:
  name: hello
  version: 1.0.0
  title: Hello
tools:
  - name: greet
    description: Greet someone.
    inputSchema:
      type: object
      properties:
        name:
          type: string
      required:
        - name
      additionalProperties: false
    fulfilment:
      steps:
        - id: build
          map:
            message: "Hello, \${input.name}!"
      output:
        message: \${steps.build.message}
`;

const OWNER_SUBJECT = 'google-owner-sub';
const MEMBER_SUBJECT = 'google-member-sub';
const ISSUER = 'https://as.noodle.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const ACCEPT = 'application/json, text/event-stream';
const FIREBASE_PROJECT_ID = 'noodleseed-prod';
const FIREBASE_API_KEY = 'firebase-public-web-api-key';
const FIREBASE_AUTH_DOMAIN = 'noodleseed-prod.firebaseapp.com';
const CUSTOMER_AUTH_MANIFEST = `
manifestVersion: "1"
server:
  name: firebase_customer_auth
  version: 1.0.0
  title: Firebase Customer Auth
  auth:
    kind: bridge
    provider: firebase
    projectId: ${FIREBASE_PROJECT_ID}
    apiKey: ${FIREBASE_API_KEY}
    authDomain: ${FIREBASE_AUTH_DOMAIN}
    user:
      id: sub
      email: email
      scopes: app.scopes
tools:
  - name: whoami
    description: Return the verified customer.
    inputSchema:
      type: object
      additionalProperties: false
    fulfilment:
      steps:
        - id: user
          map:
            subject: \${user.subject}
            email: \${user.email}
      output:
        subject: \${steps.user.subject}
        email: \${steps.user.email}
`;
// Control-plane Google verifier: accepts any token as the deployer (fixes the owner identity).
const controlGoogle: GoogleIdTokenVerifier = {
  verify: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
};

let http: Server;
let base: string;
let signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
let oauthStore: InMemoryOAuthStore;
let googleSubject: string;
let googleEmail: string;
let googleLocale: string | undefined;
let googleTimeZone: string | undefined;
let provider: NoodleOAuthProvider;

beforeEach(async () => {
  googleSubject = OWNER_SUBJECT; // the AS-authenticated human; overridden per-test for the non-owner case
  googleEmail = 'owner@noodleseed.com';
  googleLocale = 'EN-gb';
  googleTimeZone = 'europe/london';
  signer = await createStaticSigningKeyProvider();
  oauthStore = new InMemoryOAuthStore();
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: OWNER_SUBJECT,
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: MEMBER_SUBJECT,
    email: 'member@noodleseed.com',
    role: 'developer',
  });
  const google: GoogleAuthenticator = {
    authorizationUrl: (state) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: () =>
      Promise.resolve({
        subject: googleSubject,
        email: googleEmail,
        ...(googleLocale !== undefined ? { locale: googleLocale } : {}),
        ...(googleTimeZone !== undefined ? { timeZone: googleTimeZone } : {}),
      }),
  };
  provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: oauthStore,
    signer,
    google,
    allowedEmailDomain: '@noodleseed.com',
  });
  const app = createOAuthApp(provider);
  const verifyOwnerToken = createJwtVerifier({
    issuer: ISSUER,
    keyResolver: await signer.verifierKey(),
  });

  http = createServer(
    createServiceHandler(new ServerRegistry(), {
      deployGate: new GoogleControlPlaneGate({
        audience: 'cp',
        admins: [],
        verifier: controlGoogle,
      }),
      controlPlaneStore: controlPlane,
      verifyOwnerToken,
      authServerIssuer: ISSUER,
      authServerApp: app as never,
    }),
  );
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => http.close((e) => (e ? reject(e) : resolve())));
});

async function deployOwnerOnly(b: string = base): Promise<string> {
  const res = await raw('POST', `${b}/v1/orgs/acme/apps/priv/envs/prod/deploy`, {
    headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'owner-only' }),
  });
  expect(res.status).toBe(201);
  return JSON.parse(res.text).url as string;
}

async function deployOrgMembers(): Promise<string> {
  const res = await raw('POST', `${base}/v1/orgs/acme/apps/team/envs/prod/deploy`, {
    headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
    body: JSON.stringify({ manifest: HELLO, accessMode: 'org-members' }),
  });
  expect(res.status).toBe(201);
  return JSON.parse(res.text).url as string;
}

async function registerClient(b: string = base): Promise<string> {
  const res = await raw('POST', `${b}/register`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Test MCP Client',
      application_type: 'web',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(res.status).toBe(201);
  return JSON.parse(res.text).client_id as string;
}

/** Drive authorize → Google callback → consent(approve) and return the issued authorization code. */
async function runToConsent(
  clientId: string,
  challenge: string,
  resource: string,
  decision: 'approve' | 'deny' = 'approve',
  b: string = base,
  redirectUri: string = REDIRECT,
): Promise<RawResponse> {
  const authorize = await raw(
    'GET',
    `${b}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=client-state-123&resource=${encodeURIComponent(resource)}`,
  );
  expect(authorize.status).toBe(302);
  const googleUrl = new URL(authorize.headers.location as string);
  const nonce = googleUrl.searchParams.get('state') as string;
  expect(nonce).toBeTruthy();

  const callback = await raw(
    'GET',
    `${b}/oauth/google/callback?code=g-code&state=${encodeURIComponent(nonce)}`,
  );
  expect(callback.status).toBe(200);
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(callback.text)?.[1];
  expect(consentToken).toBeTruthy();

  return raw(
    'POST',
    `${b}/oauth/consent`,
    form({ consent_token: consentToken as string, decision }),
  );
}

async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
  b: string = base,
  redirectUri: string = REDIRECT,
): Promise<RawResponse> {
  return raw(
    'POST',
    `${b}/token`,
    form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: redirectUri,
      resource,
    }),
  );
}

function exchangeRefresh(
  clientId: string,
  refreshToken: string,
  resource: string,
  b: string = base,
): Promise<RawResponse> {
  return raw(
    'POST',
    `${b}/token`,
    form({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }),
  );
}

/**
 * Build a second authorization-server instance with a custom refresh grace window and/or injected clock —
 * used to assert out-of-grace reuse deterministically without waiting on the real 30s window.
 */
async function buildServer(
  opts: {
    now?: () => number;
    refreshTokenGraceSeconds?: number;
    refreshTokenRecoverySeconds?: number;
    trustProxy?: boolean;
  } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const store = new InMemoryOAuthStore();
  const google: GoogleAuthenticator = {
    authorizationUrl: (state) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
  };
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store,
    signer,
    google,
    allowedEmailDomain: '@noodleseed.com',
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.refreshTokenGraceSeconds !== undefined
      ? { refreshTokenGraceSeconds: opts.refreshTokenGraceSeconds }
      : {}),
    ...(opts.refreshTokenRecoverySeconds !== undefined
      ? { refreshTokenRecoverySeconds: opts.refreshTokenRecoverySeconds }
      : {}),
  });
  const app = createOAuthApp(provider, { trustProxy: opts.trustProxy === true });
  const verifyOwnerToken = createJwtVerifier({
    issuer: ISSUER,
    keyResolver: await signer.verifierKey(),
  });
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: OWNER_SUBJECT,
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  const server = createServer(
    createServiceHandler(new ServerRegistry(), {
      deployGate: new GoogleControlPlaneGate({
        audience: 'cp',
        admins: [],
        verifier: controlGoogle,
      }),
      controlPlaneStore: controlPlane,
      verifyOwnerToken,
      authServerIssuer: ISSUER,
      authServerApp: app as never,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const b = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base: b,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
  };
}

describe('OA-2 authorization server — full owner-only login flow', () => {
  it('rejects normalized web loopback port substitution directly before upstream authorization', async () => {
    const registered = await raw('POST', `${base}/register`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Exact loopback client',
        redirect_uris: ['http://127.0.0.1:49152/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }),
    });
    expect(registered.status).toBe(201);
    const clientId = JSON.parse(registered.text).client_id as string;

    const response = await raw(
      'GET',
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        '&redirect_uri=http%3A%2F%2F127.0.0.1%3A49153%2Fcallback' +
        '&code_challenge=test-challenge&code_challenge_method=S256',
    );

    expect(response.status).toBe(400);
    expect(response.headers.location).toBeUndefined();
    expect(JSON.parse(response.text)).toEqual({
      error: 'invalid_request',
      error_description: 'redirect_uri is not permitted for this client',
    });
    expect(response.text).not.toContain('49152');
    expect(response.text).not.toContain('49153');
  });

  it('DCR → authorize → Google → consent → token → authenticated MCP call', async () => {
    const url = await deployOwnerOnly();
    const resource = url;
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();

    const consent = await runToConsent(clientId, challenge, resource);
    expect(consent.status).toBe(302);
    const redirect = new URL(consent.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('client-state-123');
    expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    const code = redirect.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const token = await exchangeCode(clientId, code, verifier, resource);
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.text);
    expect(tokens.token_type.toLowerCase()).toBe('bearer');
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    const verifyIssuedToken = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verifyIssuedToken(tokens.access_token, resource)).resolves.toMatchObject({
      caller: {
        locale: 'en-GB',
        timeZone: 'Europe/London',
        oauthClientId: clientId,
      },
    });
    expect((await verifyIssuedToken(tokens.access_token, resource))?.caller).not.toHaveProperty(
      'developerGrantId',
    );
    const refreshed = JSON.parse(
      (await exchangeRefresh(clientId, tokens.refresh_token, resource)).text,
    );
    await expect(verifyIssuedToken(refreshed.access_token, resource)).resolves.toMatchObject({
      caller: {
        locale: 'en-GB',
        timeZone: 'Europe/London',
        oauthClientId: clientId,
      },
    });

    // The minted token authenticates against the owner-only resource server (OA-1).
    const init = await mcpInit(url, tokens.access_token);
    expect(init.status).toBe(200);
    const call = await raw('POST', url, {
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        'mcp-protocol-version': '2025-11-25',
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'Ada' } },
      }),
    });
    expect(call.status).toBe(200);
    expect(JSON.parse(call.text).result.structuredContent).toEqual({ message: 'Hello, Ada!' });
  });

  it('bridges Firebase customer auth into resource-bound Noodle MCP tokens', async () => {
    const srv = await buildCustomerBridgeServer({
      signer,
      issuer: ISSUER,
      ownerSubject: OWNER_SUBJECT,
      firebaseProjectId: FIREBASE_PROJECT_ID,
      controlGoogle,
    });
    try {
      const deploy = await raw('POST', `${srv.base}/v1/orgs/acme/apps/customers/envs/prod/deploy`, {
        headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
        body: JSON.stringify({ manifest: CUSTOMER_AUTH_MANIFEST, accessMode: 'customers' }),
      });
      expect(deploy.status).toBe(201);
      const resource = JSON.parse(deploy.text).url as string;
      const clientId = await registerClient(srv.base);
      const { verifier, challenge } = pkce();

      const authorize = await raw(
        'GET',
        `${srv.base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
          `&code_challenge_method=S256&state=client-state-123&resource=${encodeURIComponent(resource)}` +
          `&scope=${encodeURIComponent('tickets.read tickets.write')}`,
      );
      expect(authorize.status).toBe(302);
      const tenantAuthorize = new URL(authorize.headers.location as string);
      expect(tenantAuthorize.origin + tenantAuthorize.pathname).toBe(
        `${ISSUER}/oauth/customer/firebase/authorize`,
      );
      expect(tenantAuthorize.searchParams.get('resource')).toBe(resource);
      expect(tenantAuthorize.searchParams.get('redirect_uri')).toBe(
        `${ISSUER}/oauth/customer/firebase/callback`,
      );
      expect(tenantAuthorize.searchParams.get('project_id')).toBe(FIREBASE_PROJECT_ID);
      const bridgeState = tenantAuthorize.searchParams.get('state') as string;
      expect(bridgeState).toBeTruthy();

      const authorizePage = await raw(
        'GET',
        `${srv.base}/oauth/customer/firebase/authorize${tenantAuthorize.search}`,
      );
      expect(authorizePage.status).toBe(200);
      expect(authorizePage.text).toContain('Continue with Google');
      expect(authorizePage.text).toContain(FIREBASE_API_KEY);
      expect(authorizePage.text).toContain(FIREBASE_AUTH_DOMAIN);

      const invalidCallback = new URL(`${srv.base}/oauth/customer/firebase/authorize`);
      invalidCallback.search = tenantAuthorize.search;
      invalidCallback.searchParams.set('redirect_uri', 'https://evil.example/callback');
      const invalidPage = await raw('GET', invalidCallback.href);
      expect(invalidPage.status).toBe(400);
      expect(invalidPage.text).toContain(
        'This authorization request did not come from Noodle Cloud.',
      );

      const callback = await raw(
        'POST',
        `${srv.base}/oauth/customer/firebase/callback`,
        form({
          state: bridgeState,
          id_token: await srv.firebaseToken(),
          refresh_token: 'firebase-refresh-token-for-customer',
        }),
      );
      expect(callback.status).toBe(302);
      const redirect = new URL(callback.headers.location as string);
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
      expect(redirect.searchParams.get('state')).toBe('client-state-123');
      const code = redirect.searchParams.get('code') as string;
      expect(code).toBeTruthy();
      await expect(
        srv.store.getDelegatedCredential({
          resource,
          provider: 'firebase',
          subject: 'firebase-customer-sub',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          credential: { enc: 'none', values: { token: 'firebase-refresh-token-for-customer' } },
        }),
      );

      const token = await exchangeCode(clientId, code, verifier, resource, srv.base);
      expect(token.status).toBe(200);
      const tokens = JSON.parse(token.text);
      const verifyIssuedToken = createJwtVerifier({
        issuer: ISSUER,
        keyResolver: await signer.verifierKey(),
      });
      await expect(verifyIssuedToken(tokens.access_token, resource)).resolves.toMatchObject({
        caller: {
          locale: 'fr-FR',
          timeZone: 'Europe/Paris',
          scopes: ['tickets.read', 'tickets.write'],
        },
        customerIssuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`,
      });
      expect((await mcpInit(resource, tokens.access_token)).status).toBe(200);

      const call = await raw('POST', resource, {
        headers: {
          'content-type': 'application/json',
          accept: ACCEPT,
          'mcp-protocol-version': '2025-11-25',
          authorization: `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'whoami', arguments: {} },
        }),
      });
      expect(call.status).toBe(200);
      expect(JSON.parse(call.text).result.structuredContent).toEqual({
        subject: 'firebase-customer-sub',
        email: 'customer@noodleseed.com',
      });

      const platformToken = await mintAccessToken(
        signer,
        {
          issuer: ISSUER,
          subject: OWNER_SUBJECT,
          audience: resource,
          email: 'owner@noodleseed.com',
        },
        3600,
      );
      expect((await mcpInit(resource, platformToken)).status).toBe(401);

      const refreshed = await exchangeRefresh(clientId, tokens.refresh_token, resource, srv.base);
      expect(refreshed.status).toBe(200);
      const refreshedTokens = JSON.parse(refreshed.text);
      await expect(
        verifyIssuedToken(refreshedTokens.access_token, resource),
      ).resolves.toMatchObject({
        caller: {
          locale: 'fr-FR',
          timeZone: 'Europe/Paris',
        },
      });
      expect((await mcpInit(resource, refreshedTokens.access_token)).status).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('keeps the OAuth resource parameter mandatory for ordinary clients', async () => {
    const clientId = await registerClient();
    const { challenge } = pkce();

    const authorize = await raw(
      'GET',
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
        '&code_challenge_method=S256&state=missing-resource',
    );
    expect(authorize.status).toBe(302);
    const redirect = new URL(authorize.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
    expect(redirect.searchParams.get('error')).toBe('invalid_request');
    expect(redirect.searchParams.get('error_description')).toBe(
      'the resource parameter is required',
    );
    expect(redirect.searchParams.get('state')).toBe('missing-resource');
    expect(redirect.searchParams.get('iss')).toBe(ISSUER);
  });

  it('rotates refresh tokens; a benign reuse within the grace window still succeeds', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    const first = JSON.parse((await exchangeCode(clientId, code, verifier, resource)).text);

    const refresh = (token: string): Promise<RawResponse> =>
      exchangeRefresh(clientId, token, resource);

    const refreshOnce = await refresh(first.refresh_token);
    expect(refreshOnce.status).toBe(200);
    const rotated = JSON.parse(refreshOnce.text);
    expect(rotated.refresh_token).not.toBe(first.refresh_token);

    // Immediate reuse of the original token is a benign concurrent/retry within the 30s grace window → 200
    // (before the fix this returned 400 invalid_grant, which triggered the production reconnect loop).
    const reuse = await refresh(first.refresh_token);
    expect(reuse.status).toBe(200);
    expect(JSON.parse(reuse.text).refresh_token).toBeTruthy();

    // The rotated access token still works against the resource server.
    expect((await mcpInit(resource, rotated.access_token)).status).toBe(200);
  });

  it('resolves two concurrent refreshes of the same token without invalid_grant (loop repro)', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    const first = JSON.parse((await exchangeCode(clientId, code, verifier, resource)).text);

    const refresh = (token: string): Promise<RawResponse> =>
      exchangeRefresh(clientId, token, resource);

    // Exactly the deploy-step pattern: parallel refreshes of the same token. Both must succeed.
    const [a, b] = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const ta = JSON.parse(a.text);
    const tb = JSON.parse(b.text);
    // Both refreshed access tokens authenticate against the resource server.
    expect((await mcpInit(resource, ta.access_token)).status).toBe(200);
    expect((await mcpInit(resource, tb.access_token)).status).toBe(200);
  });

  it('rejects reuse outside the grace window and revokes the whole family', async () => {
    let clockMs = Date.now();
    const srv = await buildServer({
      now: () => clockMs,
      refreshTokenRecoverySeconds: 30,
    });
    try {
      const resource = `${ISSUER}/o/acme/grace/envs/prod/mcp`;
      const clientId = await registerClient(srv.base);
      const { verifier, challenge } = pkce();
      const consent = await runToConsent(clientId, challenge, resource, 'approve', srv.base);
      const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
      const first = JSON.parse(
        (await exchangeCode(clientId, code, verifier, resource, srv.base)).text,
      );

      const refresh = (token: string): Promise<RawResponse> =>
        exchangeRefresh(clientId, token, resource, srv.base);

      const rotated = JSON.parse((await refresh(first.refresh_token)).text); // rotated at clockMs
      clockMs += 31_000; // advance past the 30s grace window

      const reuse = await refresh(first.refresh_token);
      expect(reuse.status).toBe(400);
      expect(JSON.parse(reuse.text).error).toBe('invalid_grant');

      // Family revoked on out-of-window reuse: even the valid successor token is now rejected.
      const successor = await refresh(rotated.refresh_token);
      expect(successor.status).toBe(400);
    } finally {
      await srv.close();
    }
  });

  it('recovers when a refresh response is lost and the old token is retried after grace', async () => {
    let clockMs = Date.now();
    const srv = await buildServer({ now: () => clockMs });
    try {
      const resource = await deployOwnerOnly(srv.base);
      const clientId = await registerClient(srv.base);
      const { verifier, challenge } = pkce();
      const consent = await runToConsent(clientId, challenge, resource, 'approve', srv.base);
      const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
      const first = JSON.parse(
        (await exchangeCode(clientId, code, verifier, resource, srv.base)).text,
      );

      const lost = JSON.parse(
        (await exchangeRefresh(clientId, first.refresh_token, resource, srv.base)).text,
      );
      clockMs += 60_000; // outside 30s grace, inside default 300s recovery window

      const recovered = await exchangeRefresh(clientId, first.refresh_token, resource, srv.base);
      expect(recovered.status).toBe(200);
      const tokens = JSON.parse(recovered.text);
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.refresh_token).not.toBe(lost.refresh_token);
      expect((await mcpInit(resource, tokens.access_token)).status).toBe(200);

      // The abandoned successor from the lost response was invalidated; only the recovered head continues.
      expect((await exchangeRefresh(clientId, lost.refresh_token, resource, srv.base)).status).toBe(
        400,
      );
      expect(
        (await exchangeRefresh(clientId, tokens.refresh_token, resource, srv.base)).status,
      ).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('rejects token requests that omit the RFC 8707 resource before consuming grants', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;

    const missingOnCode = await raw(
      'POST',
      `${base}/token`,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
      }),
    );
    expect(missingOnCode.status).toBe(400);
    expect(JSON.parse(missingOnCode.text).error).toBe('invalid_request');

    const issued = JSON.parse((await exchangeCode(clientId, code, verifier, resource)).text);
    const missingOnRefresh = await raw(
      'POST',
      `${base}/token`,
      form({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        client_id: clientId,
      }),
    );
    expect(missingOnRefresh.status).toBe(400);
    expect(JSON.parse(missingOnRefresh.text).error).toBe('invalid_request');

    expect((await exchangeRefresh(clientId, issued.refresh_token, resource)).status).toBe(200);
  });

  it('uses a proxy-aware OAuth rate-limit key without express-rate-limit forwarded-header errors', async () => {
    const srv = await buildServer({ trustProxy: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const register = await raw('POST', `${srv.base}/register`, {
        headers: {
          'content-type': 'application/json',
          forwarded: 'for=203.0.113.10;proto=https;host=cloud.noodleseed.dev',
          'x-forwarded-for': '203.0.113.10, 10.0.0.8',
        },
        body: JSON.stringify({
          client_name: 'Proxy MCP Client',
          application_type: 'web',
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      });
      expect(register.status).toBe(201);
      const invalidRefresh = await raw('POST', `${srv.base}/token`, {
        headers: {
          ...form({}).headers,
          forwarded: 'for=203.0.113.10;proto=https;host=cloud.noodleseed.dev',
          'x-forwarded-for': '203.0.113.10, 10.0.0.8',
        },
        body: form({
          grant_type: 'refresh_token',
          refresh_token: 'not-a-token',
          client_id: 'unknown-client',
          resource: `${ISSUER}/o/acme/proxy/envs/prod/mcp`,
        }).body,
      });
      expect(invalidRefresh.status).toBeGreaterThanOrEqual(400);
      expect(invalidRefresh.status).toBeLessThan(500);
      const logged = consoleError.mock.calls.flat().map(String).join('\n');
      expect(logged).not.toContain('ERR_ERL_FORWARDED_HEADER');
      expect(logged).not.toContain('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR');
    } finally {
      consoleError.mockRestore();
      await srv.close();
    }
  });

  it('rejects a wrong PKCE verifier and a replayed authorization code', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;

    const wrong = await exchangeCode(clientId, code, 'not-the-verifier', resource);
    expect(wrong.status).toBe(400); // PKCE mismatch (invalid_grant)
    expect(JSON.parse(wrong.text).error).toBe('invalid_grant');

    // Even with the right verifier afterward, the code is single-use — already failed/consumed.
    const replay = await exchangeCode(clientId, code, 'irrelevant', resource);
    expect(replay.status).toBe(400);
  });

  it('denying consent redirects to the client with access_denied (no code issued)', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource, 'deny');
    expect(consent.status).toBe(302);
    const redirect = new URL(consent.headers.location as string);
    expect(redirect.searchParams.get('error')).toBe('access_denied');
    expect(redirect.searchParams.get('state')).toBe('client-state-123');
    expect(redirect.searchParams.get('iss')).toBe(ISSUER);
    expect(redirect.searchParams.get('code')).toBeNull();
  });

  it('accepts a legacy MCPJam registration without application_type', async () => {
    const redirectUri = 'http://127.0.0.1:6274/oauth/callback';
    const registration = await raw('POST', `${base}/register`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'MCPJam - noodle dev',
        client_uri: 'https://github.com/mcpjam/inspector',
        logo_uri: 'https://www.mcpjam.com/mcp_jam_2row.png',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const clientId = JSON.parse(registration.text).client_id as string;

    const resource = await deployOwnerOnly();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource, 'approve', base, redirectUri);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    expect((await exchangeCode(clientId, code, verifier, resource, base, redirectUri)).status).toBe(
      200,
    );
  });

  it('rejects an explicit invalid dynamic registration application_type', async () => {
    const registration = await raw('POST', `${base}/register`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Invalid application type',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'desktop',
      }),
    });
    expect(registration.status).toBe(400);
    expect(JSON.parse(registration.text)).toEqual({
      error: 'invalid_client_metadata',
      error_description: 'application_type must be web or native',
    });
  });

  it('forbids a token minted for a non-owner subject (403 at the resource server)', async () => {
    const resource = await deployOwnerOnly();
    const intruderToken = await mintAccessToken(
      signer,
      { issuer: ISSUER, subject: 'intruder-sub', audience: resource },
      3600,
    );
    expect((await mcpInit(resource, intruderToken)).status).toBe(403);
  });

  it('allows a token minted for a non-owner org member on an org-members deployment', async () => {
    const resource = await deployOrgMembers();
    googleSubject = MEMBER_SUBJECT;
    googleEmail = 'member@noodleseed.com';
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, resource);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    const token = await exchangeCode(clientId, code, verifier, resource);
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.text);

    expect((await mcpInit(resource, tokens.access_token)).status).toBe(200);
  });

  it('forbids a token minted for a non-member on an org-members deployment', async () => {
    const resource = await deployOrgMembers();
    const outsiderToken = await mintAccessToken(
      signer,
      { issuer: ISSUER, subject: 'outsider-sub', audience: resource },
      3600,
    );
    expect((await mcpInit(resource, outsiderToken)).status).toBe(403);
  });

  it('serves RFC 8414 authorization-server metadata + a public JWKS', async () => {
    const meta = await raw('GET', `${base}/.well-known/oauth-authorization-server`);
    expect(meta.status).toBe(200);
    const m = JSON.parse(meta.text);
    expect(m.issuer).toBe(ISSUER);
    expect(m.authorization_endpoint).toBe(`${ISSUER}/authorize`);
    expect(m.token_endpoint).toBe(`${ISSUER}/token`);
    expect(m.registration_endpoint).toBe(`${ISSUER}/register`);
    expect(m.authorization_response_iss_parameter_supported).toBe(true);
    expect(m.code_challenge_methods_supported).toEqual(['S256']);
    expect(m.grant_types_supported).toContain('refresh_token');
    expect(m.grant_types_supported).toContain(DEVICE_GRANT);
    expect(m.device_authorization_endpoint).toBe(`${ISSUER}/device_authorization`);
    expect(m.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);

    const oidc = await raw('GET', `${base}/.well-known/openid-configuration`);
    expect(oidc.status).toBe(200);
    expect(JSON.parse(oidc.text)).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      authorization_endpoint: `${ISSUER}/authorize`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
    });

    const jwks = await raw('GET', `${base}/.well-known/jwks.json`);
    expect(jwks.status).toBe(200);
    const keys = JSON.parse(jwks.text).keys;
    expect(keys[0].kty).toBe('RSA');
    expect(keys[0]).not.toHaveProperty('d');
  });

  it('rejects a Google account outside the allowed email domain at the callback (403)', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const { challenge } = pkce();
    googleEmail = 'outsider@gmail.com'; // the AS-authenticated human is not a @noodleseed.com identity
    const authorize = await raw(
      'GET',
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
        `&code_challenge_method=S256&resource=${encodeURIComponent(resource)}`,
    );
    const nonce = new URL(authorize.headers.location as string).searchParams.get('state') as string;
    const callback = await raw(
      'GET',
      `${base}/oauth/google/callback?code=g&state=${encodeURIComponent(nonce)}`,
    );
    expect(callback.status).toBe(403);
  });
});

/**
 * Remembered consent (standard OAuth): once a human approves a `(client, subject, resource)` tuple, a later
 * authorization for the SAME tuple skips the consent interstitial and issues the code directly — so a client
 * that re-runs authorization (e.g. ChatGPT, which does not persist its MCP session) does not re-prompt the
 * user. A new client or resource still requires explicit consent (ADR 0042 confused-deputy guard intact).
 */
describe('OA-2 remembered consent (skip interstitial on reauthorization)', () => {
  // authorize → Google callback, returning the RAW callback response (200 consent page, or 302 code on skip).
  async function authorizeToCallback(
    clientId: string,
    challenge: string,
    resource: string,
  ): Promise<RawResponse> {
    const authorize = await raw(
      'GET',
      `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
        `&code_challenge_method=S256&state=client-state-123&resource=${encodeURIComponent(resource)}`,
    );
    expect(authorize.status).toBe(302);
    const nonce = new URL(authorize.headers.location as string).searchParams.get('state') as string;
    return raw(
      'GET',
      `${base}/oauth/google/callback?code=g-code&state=${encodeURIComponent(nonce)}`,
    );
  }

  it('skips the consent page on a second authorize for the same client+subject+resource', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();

    // First authorization: consent page shown, approve → code.
    const first = await runToConsent(clientId, pkce().challenge, resource);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.location as string).searchParams.get('code')).toBeTruthy();

    // Second authorization (same tuple): the callback issues the code DIRECTLY (302), no consent HTML.
    const { verifier, challenge } = pkce();
    const callback = await authorizeToCallback(clientId, challenge, resource);
    expect(callback.status).toBe(302);
    expect(callback.headers['content-type'] ?? '').not.toContain('html');
    const loc = new URL(callback.headers.location as string);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('client-state-123');
    const code = loc.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    // The silently-issued code still exchanges for a working token.
    const token = await exchangeCode(clientId, code, verifier, resource);
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.text);
    expect(typeof tokens.access_token).toBe('string');
    const verifyIssuedToken = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verifyIssuedToken(tokens.access_token, resource)).resolves.toMatchObject({
      caller: {
        locale: 'en-GB',
        timeZone: 'Europe/London',
      },
    });
  });

  it('still shows consent for a different resource (confused-deputy guard intact)', async () => {
    const r1 = await deployOwnerOnly();
    const clientId = await registerClient();
    await runToConsent(clientId, pkce().challenge, r1); // grant for (client, owner, r1)

    const r2 = await deployOrgMembers(); // a different resource the same owner controls
    const callback = await authorizeToCallback(clientId, pkce().challenge, r2);
    expect(callback.status).toBe(200);
    expect(/name="consent_token"/.test(callback.text)).toBe(true);
  });

  it('still shows consent for a different client (no grant reuse across clients)', async () => {
    const resource = await deployOwnerOnly();
    const clientA = await registerClient();
    await runToConsent(clientA, pkce().challenge, resource); // grant for (clientA, owner, resource)

    const clientB = await registerClient();
    const callback = await authorizeToCallback(clientB, pkce().challenge, resource);
    expect(callback.status).toBe(200);
    expect(/name="consent_token"/.test(callback.text)).toBe(true);
  });

  it('a denied consent does NOT persist a grant — the next authorize still prompts', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    const denied = await runToConsent(clientId, pkce().challenge, resource, 'deny');
    expect(denied.status).toBe(302);
    expect(new URL(denied.headers.location as string).searchParams.get('error')).toBe(
      'access_denied',
    );
    // Deny created no grant → a fresh authorization still shows the consent page (not a silent skip).
    const callback = await authorizeToCallback(clientId, pkce().challenge, resource);
    expect(callback.status).toBe(200);
    expect(/name="consent_token"/.test(callback.text)).toBe(true);
  });

  it('a different human (Google subject) must consent even for an already-approved client+resource', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    await runToConsent(clientId, pkce().challenge, resource); // owner grants

    // A different signed-in human for the same client+resource has no grant → consent is shown.
    googleSubject = MEMBER_SUBJECT;
    googleEmail = 'member@noodleseed.com';
    const callback = await authorizeToCallback(clientId, pkce().challenge, resource);
    expect(callback.status).toBe(200);
    expect(/name="consent_token"/.test(callback.text)).toBe(true);
  });

  it('remembered consent never bypasses the email-domain gate — a disallowed account still gets 403', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    await runToConsent(clientId, pkce().challenge, resource); // an allowed-domain owner grants this tuple

    // A disallowed-domain human authorizing the same client+resource is rejected at the callback (the domain
    // gate runs before the grant check), so a stored grant can never be used to skip authorization.
    googleSubject = 'outsider-sub';
    googleEmail = 'attacker@evil.example';
    const callback = await authorizeToCallback(clientId, pkce().challenge, resource);
    expect(callback.status).toBe(403);
  });

  it('still enforces PKCE on the silently-issued (remembered-consent) code', async () => {
    const resource = await deployOwnerOnly();
    const clientId = await registerClient();
    await runToConsent(clientId, pkce().challenge, resource); // create the grant

    const callback = await authorizeToCallback(clientId, pkce().challenge, resource);
    expect(callback.status).toBe(302);
    const code = new URL(callback.headers.location as string).searchParams.get('code') as string;
    // A wrong verifier on the skip-issued code is still rejected — consent-skip does not weaken PKCE.
    expect((await exchangeCode(clientId, code, 'not-the-verifier', resource)).status).toBe(400);
  });
});

/**
 * Conformance: a single authorization yields a token reusable across many authenticated MCP calls — proving a
 * well-behaved client authenticates ONCE and does not loop. Our transport is stateless (ADR 0036), so the
 * bearer token serves `initialize` and repeated tool calls with no second `/authorize` or `/token`. ChatGPT's
 * production loop is its documented mcp-session-id non-persistence bug, not the server (see
 * docs/references/mcp-source-notes.md).
 */
describe('OA-2 conformance: one authorization serves many authenticated MCP calls (no re-auth loop)', () => {
  it('a single OAuth flow yields a token reusable across initialize + repeated tools/list and tools/call', async () => {
    const url = await deployOwnerOnly();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, url);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    const access = JSON.parse((await exchangeCode(clientId, code, verifier, url)).text)
      .access_token as string;

    const mcp = (id: number, method: string, params: unknown): Promise<RawResponse> =>
      raw('POST', url, {
        headers: {
          'content-type': 'application/json',
          accept: ACCEPT,
          'mcp-protocol-version': '2025-11-25',
          authorization: `Bearer ${access}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });

    expect((await mcpInit(url, access)).status).toBe(200);
    expect((await mcp(2, 'tools/list', {})).status).toBe(200);
    // Repeated tool calls with the SAME token all succeed — no re-authentication is needed or triggered.
    for (let i = 0; i < 4; i += 1) {
      const call = await mcp(10 + i, 'tools/call', { name: 'greet', arguments: { name: `n${i}` } });
      expect(call.status).toBe(200);
      expect(JSON.parse(call.text).result.structuredContent).toEqual({ message: `Hello, n${i}!` });
    }
  });
});

/**
 * Conformance with the OFFICIAL MCP SDK client over real HTTP (not our hand-rolled requests): the reference
 * `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`, carrying a bearer token via
 * `requestInit`, completes `initialize` and issues many tool calls on one token — the strongest proof that a
 * spec-conformant client does not loop against our stateless transport + authorization server.
 */
describe('OA-2 conformance with the official MCP SDK client (StreamableHTTP + bearer token)', () => {
  it('the reference SDK Client makes initialize + repeated tool calls on one token (no re-auth)', async () => {
    const url = await deployOwnerOnly();
    const clientId = await registerClient();
    const { verifier, challenge } = pkce();
    const consent = await runToConsent(clientId, challenge, url);
    const code = new URL(consent.headers.location as string).searchParams.get('code') as string;
    const access = JSON.parse((await exchangeCode(clientId, code, verifier, url)).text)
      .access_token as string;

    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${access}` } },
    });
    const client = new Client({ name: 'conformance-client', version: '1.0.0' });
    try {
      await client.connect(transport); // MCP initialize handshake over HTTP, with the bearer token
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain('greet');
      // The SAME token serves repeated calls — a conformant client authenticates once and never re-authorizes.
      for (let i = 0; i < 4; i += 1) {
        const result = await client.callTool({ name: 'greet', arguments: { name: `c${i}` } });
        expect(result.structuredContent).toEqual({ message: `Hello, c${i}!` });
      }
    } finally {
      await client.close();
    }
  });
});

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { geminiEnterpriseDefaultResourceForClient } from '../src/gemini-enterprise-oauth.js';
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

const OWNER_SUBJECT = 'google-owner-sub';
const ISSUER = 'https://as.noodle.test';
const GEMINI_REDIRECT = 'https://vertexaisearch.cloud.google.com/oauth-redirect';
const GEMINI_STATIC_REDIRECT = 'https://vertexaisearch.cloud.google.com/static/oauth/oauth.html';

const controlGoogle: GoogleIdTokenVerifier = {
  verify: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
};

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function raw(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        ...(opts.headers ? { headers: opts.headers } : {}),
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: data }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function form(fields: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

let http: Server;
let base: string;
let signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;

beforeEach(async () => {
  signer = await createStaticSigningKeyProvider();
  const google: GoogleAuthenticator = {
    authorizationUrl: (state) =>
      `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
    exchange: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
  };
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: new InMemoryOAuthStore(),
    signer,
    google,
    allowedEmailDomain: '@noodleseed.com',
    defaultResourceForClient: (client) => geminiEnterpriseDefaultResourceForClient(client, ISSUER),
  });
  const app = createOAuthApp(provider);
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

async function registerGeminiClient(resource: string): Promise<{
  readonly clientId: string;
  readonly clientSecret: string;
}> {
  const res = await raw('POST', `${base}/register`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `Gemini Enterprise MCP ${resource}`,
      application_type: 'web',
      redirect_uris: [GEMINI_REDIRECT, GEMINI_STATIC_REDIRECT],
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  expect(res.status).toBe(201);
  const body = JSON.parse(res.text) as { client_id: string; client_secret: string };
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

async function runGeminiToConsentWithoutResource(
  clientId: string,
  challenge: string,
): Promise<RawResponse> {
  const authorize = await raw(
    'GET',
    `${base}/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(GEMINI_REDIRECT)}&code_challenge=${challenge}` +
      '&code_challenge_method=S256&state=gemini-client-state',
  );
  expect(authorize.status).toBe(302);
  const googleUrl = new URL(authorize.headers.location as string);
  const nonce = googleUrl.searchParams.get('state') as string;
  expect(nonce).toBeTruthy();

  const callback = await raw(
    'GET',
    `${base}/oauth/google/callback?code=g-code&state=${encodeURIComponent(nonce)}`,
  );
  expect(callback.status).toBe(200);
  const consentToken = /name="consent_token" value="([^"]+)"/.exec(callback.text)?.[1];
  expect(consentToken).toBeTruthy();

  return raw(
    'POST',
    `${base}/oauth/consent`,
    form({ consent_token: consentToken as string, decision: 'approve' }),
  );
}

describe('Gemini Enterprise OAuth compatibility', () => {
  it('issues refresh tokens when clients omit resource but register an explicit MCP resource', async () => {
    const resource = `${ISSUER}/o/acme/priv/mcp`;
    const { clientId, clientSecret } = await registerGeminiClient(resource);
    const { verifier, challenge } = pkce();

    const consent = await runGeminiToConsentWithoutResource(clientId, challenge);
    expect(consent.status).toBe(302);
    const redirect = new URL(consent.headers.location as string);
    expect(redirect.origin + redirect.pathname).toBe(GEMINI_REDIRECT);
    expect(redirect.searchParams.get('state')).toBe('gemini-client-state');
    const code = redirect.searchParams.get('code') as string;
    expect(code).toBeTruthy();

    const token = await raw(
      'POST',
      `${base}/token`,
      form({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: GEMINI_REDIRECT,
      }),
    );
    expect(token.status).toBe(200);
    const tokens = JSON.parse(token.text);
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    const verifierForGeminiResource = createJwtVerifier({
      issuer: ISSUER,
      audience: resource,
      keyResolver: await signer.verifierKey(),
    });
    await expect(verifierForGeminiResource(tokens.access_token)).resolves.toMatchObject({
      caller: {
        subject: OWNER_SUBJECT,
        email: 'owner@noodleseed.com',
      },
    });
  });
});

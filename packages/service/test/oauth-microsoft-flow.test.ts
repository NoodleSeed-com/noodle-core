import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  createServiceHandler,
  GoogleControlPlaneGate,
  type GoogleIdTokenVerifier,
  InMemoryControlPlaneStore,
  ServerRegistry,
  type TenantAuthConfig,
} from '../src/index.js';
import { resolveTenantBridgeAuthVariables } from '../src/managed-config-expressions.js';
import { createOAuthApp } from '../src/oauth/app.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';

const OWNER_SUBJECT = 'google-owner-sub';
const ISSUER = 'https://as.noodle.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const ACCEPT = 'application/json, text/event-stream';
const MICROSOFT_TENANT_ID = 'contoso-tenant';
const MICROSOFT_CLIENT_ID = 'microsoft-client-id';
const MICROSOFT_CLIENT_SECRET_REF = 'MICROSOFT_CLIENT_SECRET';
const MICROSOFT_CLIENT_SECRET_VALUE = 'microsoft-client-secret-value';
const MICROSOFT_ISSUER = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/v2.0`;
const MICROSOFT_TOKEN_URL = `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
const MICROSOFT_JWKS_URI = `${MICROSOFT_ISSUER}/discovery/v2.0/keys`;

const MICROSOFT_CUSTOMER_AUTH_MANIFEST = `
manifestVersion: "1"
server:
  name: microsoft_customer_auth
  version: 1.0.0
  title: Microsoft Customer Auth
  auth:
    kind: bridge
    provider: microsoft
    tenantId: \${env.MICROSOFT_TENANT_ID}
    clientId: \${env.MICROSOFT_CLIENT_ID}
    clientSecret: ${MICROSOFT_CLIENT_SECRET_REF}
    scopes:
      - https://graph.microsoft.com/Sites.Selected
      - https://graph.microsoft.com/User.Read
    authMethod: client_secret_post
    user:
      id: sub
      email: preferred_username
      roles: app.roles
      scopes: app.scopes
tools:
  - name: whoami
    description: Return the verified Microsoft customer.
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

async function registerClient(base: string): Promise<string> {
  const res = await raw('POST', `${base}/register`, {
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

async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  resource: string,
  base: string,
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

async function buildMicrosoftBridgeServer(fetchImpl: typeof fetch): Promise<{
  readonly base: string;
  readonly close: () => Promise<void>;
  readonly store: InMemoryOAuthStore;
  readonly verifyAccessToken: ReturnType<typeof createJwtVerifier>;
}> {
  const signer = await createStaticSigningKeyProvider();
  const store = new InMemoryOAuthStore();
  let registry: ServerRegistry;
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store,
    signer,
    google: {
      authorizationUrl: (state) =>
        `https://accounts.google.test/auth?state=${encodeURIComponent(state)}`,
      exchange: () => Promise.resolve({ subject: OWNER_SUBJECT, email: 'owner@noodleseed.com' }),
    },
    customerBridgeAuthForResource: async (resource) => bridgeAuthForResource(registry, resource),
    managedSecretForResource: async (resource, name) =>
      managedSecretForResource(registry, resource, name),
    sealCustomerCredential: async (token) => ({ enc: 'none', values: { token } }),
    fetchImpl,
  });
  const platformVerifier = createJwtVerifier({
    issuer: ISSUER,
    keyResolver: await signer.verifierKey(),
  });
  registry = new ServerRegistry(undefined, undefined, undefined, {
    customerVerifierFactory: (auth: TenantAuthConfig) => {
      if (auth.kind !== 'bridge') return async () => null;
      return async (token, resource) => {
        const verification = await platformVerifier(token, resource);
        if (
          verification?.caller.identityKind !== 'customer' ||
          verification.caller.identityProvider !== auth.provider
        ) {
          return null;
        }
        return verification;
      };
    },
  });
  const controlPlane = new InMemoryControlPlaneStore();
  await controlPlane.addOrgMember({
    org: 'acme',
    subject: OWNER_SUBJECT,
    email: 'owner@noodleseed.com',
    role: 'owner',
  });
  const server = createServer(
    createServiceHandler(registry, {
      deployGate: new GoogleControlPlaneGate({
        audience: 'cp',
        admins: [],
        verifier: controlGoogle,
      }),
      controlPlaneStore: controlPlane,
      verifyOwnerToken: platformVerifier,
      authServerIssuer: ISSUER,
      authServerApp: createOAuthApp(provider) as never,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))),
    store,
    verifyAccessToken: platformVerifier,
  };
}

async function bridgeAuthForResource(
  registry: ServerRegistry,
  resource: string,
): Promise<Extract<TenantAuthConfig, { kind: 'bridge' }> | undefined> {
  const url = new URL(resource);
  const match = /^\/o\/([^/]+)\/([^/]+)(?:\/v\d+(?:_\d+){0,2})?\/mcp$/.exec(url.pathname);
  if (!match) return undefined;
  const target = await registry.getActiveByTenant({
    org: decodeURIComponent(match[1] as string),
    app: decodeURIComponent(match[2] as string),
    env: 'prod',
  });
  const auth = target?.served.artifact.server.auth;
  if (auth?.kind !== 'bridge') return undefined;
  const variables = await registry.configStore.resolveConfigValues('variable', {
    level: 'env',
    org: decodeURIComponent(match[1] as string),
    app: decodeURIComponent(match[2] as string),
    env: 'prod',
  });
  return resolveTenantBridgeAuthVariables(auth, variables);
}

async function managedSecretForResource(
  registry: ServerRegistry,
  resource: string,
  name: string,
): Promise<string | undefined> {
  const url = new URL(resource);
  const match = /^\/o\/([^/]+)\/([^/]+)(?:\/v\d+(?:_\d+){0,2})?\/mcp$/.exec(url.pathname);
  if (!match) return undefined;
  const values = await registry.configStore.resolveConfigValues('secret', {
    level: 'env',
    org: decodeURIComponent(match[1] as string),
    app: decodeURIComponent(match[2] as string),
    env: 'prod',
  });
  return values[name];
}

async function mintMicrosoftIdToken(
  provider: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>,
): Promise<string> {
  const key = await provider.signingKey();
  return new SignJWT({
    email: 'microsoft-customer@contoso.example',
    preferred_username: 'microsoft-customer@contoso.example',
    name: 'Microsoft Customer',
    tid: MICROSOFT_TENANT_ID,
    oid: 'microsoft-user-object-id',
    locale: 'de-de',
    zoneinfo: 'europe/berlin',
    roles: ['forged-admin'],
    app: {
      roles: ['support', ' admin ', 'support'],
      scopes: ['tickets.read', 'tickets.write'],
    },
  })
    .setProtectedHeader({ alg: key.alg, kid: key.kid })
    .setIssuer(MICROSOFT_ISSUER)
    .setSubject('microsoft-customer-sub')
    .setAudience(MICROSOFT_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key.privateKey);
}

async function microsoftFetchFor(
  provider: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>,
): Promise<{ readonly fetchImpl: typeof fetch; readonly tokenRequests: URLSearchParams[] }> {
  const jwks = await provider.publicJwks();
  const tokenRequests: URLSearchParams[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === `${MICROSOFT_ISSUER}/.well-known/openid-configuration`) {
      return jsonResponse({ issuer: MICROSOFT_ISSUER, jwks_uri: MICROSOFT_JWKS_URI });
    }
    if (url === MICROSOFT_JWKS_URI) return jsonResponse(jwks);
    if (url === MICROSOFT_TOKEN_URL) {
      const body =
        typeof init?.body === 'string'
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : '';
      tokenRequests.push(new URLSearchParams(body));
      return jsonResponse({
        token_type: 'Bearer',
        access_token: 'microsoft-graph-access-token',
        refresh_token: 'microsoft-refresh-token-for-customer',
        expires_in: 3600,
        id_token: await mintMicrosoftIdToken(provider),
      });
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, tokenRequests };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function mcpInit(url: string, token: string): Promise<RawResponse> {
  return raw('POST', url, {
    headers: {
      'content-type': 'application/json',
      accept: ACCEPT,
      'mcp-protocol-version': '2025-11-25',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    }),
  });
}

describe('Microsoft customer bridge OAuth flow', () => {
  it('bridges Microsoft customer auth and stores the first Graph refresh token', async () => {
    const microsoftSigner = await createStaticSigningKeyProvider();
    const { fetchImpl, tokenRequests } = await microsoftFetchFor(microsoftSigner);
    const srv = await buildMicrosoftBridgeServer(fetchImpl);
    try {
      const missingSecret = await raw(
        'POST',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/deploy`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({
            manifest: MICROSOFT_CUSTOMER_AUTH_MANIFEST,
            accessMode: 'customers',
          }),
        },
      );
      expect(missingSecret.status).toBe(400);
      expect(JSON.parse(missingSecret.text)).toEqual({
        ok: false,
        errors: [
          expect.objectContaining({
            code: 'missing_secret',
            path: `secrets.${MICROSOFT_CLIENT_SECRET_REF}`,
          }),
          expect.objectContaining({
            code: 'missing_variable',
            path: 'variables.MICROSOFT_CLIENT_ID',
          }),
          expect.objectContaining({
            code: 'missing_variable',
            path: 'variables.MICROSOFT_TENANT_ID',
          }),
        ],
      });

      const setSecret = await raw(
        'PUT',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/secrets/${MICROSOFT_CLIENT_SECRET_REF}`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({ value: MICROSOFT_CLIENT_SECRET_VALUE }),
        },
      );
      expect(setSecret.status).toBe(200);

      const missingVariables = await raw(
        'POST',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/deploy`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({
            manifest: MICROSOFT_CUSTOMER_AUTH_MANIFEST,
            accessMode: 'customers',
          }),
        },
      );
      expect(missingVariables.status).toBe(400);
      expect(JSON.parse(missingVariables.text)).toEqual({
        ok: false,
        errors: [
          expect.objectContaining({
            code: 'missing_variable',
            path: 'variables.MICROSOFT_CLIENT_ID',
          }),
          expect.objectContaining({
            code: 'missing_variable',
            path: 'variables.MICROSOFT_TENANT_ID',
          }),
        ],
      });

      const setTenant = await raw(
        'PUT',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/variables/MICROSOFT_TENANT_ID`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({ value: MICROSOFT_TENANT_ID }),
        },
      );
      expect(setTenant.status).toBe(200);
      const setClient = await raw(
        'PUT',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/variables/MICROSOFT_CLIENT_ID`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({ value: MICROSOFT_CLIENT_ID }),
        },
      );
      expect(setClient.status).toBe(200);

      const deploy = await raw(
        'POST',
        `${srv.base}/v1/orgs/acme/apps/microsoft-customers/envs/prod/deploy`,
        {
          headers: { 'content-type': 'application/json', authorization: 'Bearer cp-token' },
          body: JSON.stringify({
            manifest: MICROSOFT_CUSTOMER_AUTH_MANIFEST,
            accessMode: 'customers',
          }),
        },
      );
      expect(deploy.status).toBe(201);
      const resource = JSON.parse(deploy.text).url as string;

      const deniedClientId = await registerClient(srv.base);
      const deniedPkce = pkce();
      const deniedAuthorize = await raw(
        'GET',
        `${srv.base}/authorize?response_type=code&client_id=${encodeURIComponent(deniedClientId)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${deniedPkce.challenge}` +
          `&code_challenge_method=S256&resource=${encodeURIComponent(resource)}` +
          `&scope=${encodeURIComponent('tickets.read tickets.delete')}`,
      );
      const deniedMicrosoftAuthorize = new URL(deniedAuthorize.headers.location as string);
      const deniedCallback = await raw(
        'GET',
        `${srv.base}/oauth/customer/microsoft/callback?state=${encodeURIComponent(
          deniedMicrosoftAuthorize.searchParams.get('state') as string,
        )}&code=denied-ms-auth-code`,
      );
      expect(deniedCallback.status).toBe(400);
      await expect(
        srv.store.getDelegatedCredential({
          resource,
          provider: 'microsoft',
          subject: 'microsoft-customer-sub',
        }),
      ).resolves.toBeUndefined();

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
      const microsoftAuthorize = new URL(authorize.headers.location as string);
      expect(microsoftAuthorize.origin + microsoftAuthorize.pathname).toBe(
        `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`,
      );
      expect(microsoftAuthorize.searchParams.get('client_id')).toBe(MICROSOFT_CLIENT_ID);
      expect(microsoftAuthorize.searchParams.get('response_type')).toBe('code');
      expect(microsoftAuthorize.searchParams.get('redirect_uri')).toBe(
        `${ISSUER}/oauth/customer/microsoft/callback`,
      );
      expect(
        new Set((microsoftAuthorize.searchParams.get('scope') ?? '').split(/\s+/).filter(Boolean)),
      ).toEqual(
        new Set([
          'openid',
          'profile',
          'email',
          'offline_access',
          'https://graph.microsoft.com/Sites.Selected',
          'https://graph.microsoft.com/User.Read',
        ]),
      );
      const bridgeState = microsoftAuthorize.searchParams.get('state') as string;
      expect(bridgeState).toBeTruthy();

      const callback = await raw(
        'GET',
        `${srv.base}/oauth/customer/microsoft/callback?state=${encodeURIComponent(
          bridgeState,
        )}&code=ms-auth-code`,
      );
      expect(callback.status).toBe(302);
      const redirect = new URL(callback.headers.location as string);
      expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
      expect(redirect.searchParams.get('state')).toBe('client-state-123');
      const code = redirect.searchParams.get('code') as string;
      expect(code).toBeTruthy();
      expect(tokenRequests).toHaveLength(2);
      const tokenRequest = tokenRequests[1] as URLSearchParams;
      expect(tokenRequest.get('grant_type')).toBe('authorization_code');
      expect(tokenRequest.get('code')).toBe('ms-auth-code');
      expect(tokenRequest.get('redirect_uri')).toBe(`${ISSUER}/oauth/customer/microsoft/callback`);
      expect(tokenRequest.get('client_id')).toBe(MICROSOFT_CLIENT_ID);
      expect(tokenRequest.get('client_secret')).toBe(MICROSOFT_CLIENT_SECRET_VALUE);

      await expect(
        srv.store.getDelegatedCredential({
          resource,
          provider: 'microsoft',
          subject: 'microsoft-customer-sub',
        }),
      ).resolves.toEqual(
        expect.objectContaining({
          credential: { enc: 'none', values: { token: 'microsoft-refresh-token-for-customer' } },
        }),
      );

      const token = await exchangeCode(clientId, code, verifier, resource, srv.base);
      expect(token.status).toBe(200);
      const tokens = JSON.parse(token.text);
      await expect(srv.verifyAccessToken(tokens.access_token, resource)).resolves.toMatchObject({
        caller: {
          locale: 'de-DE',
          timeZone: 'Europe/Berlin',
          roles: ['admin', 'support'],
          scopes: ['tickets.read', 'tickets.write'],
        },
        customerIssuer: `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/v2.0`,
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
        subject: 'microsoft-customer-sub',
        email: 'microsoft-customer@contoso.example',
      });
    } finally {
      await srv.close();
    }
  });
});

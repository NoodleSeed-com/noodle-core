import { createServer, type Server } from 'node:http';
import { createJwtVerifier, createStaticSigningKeyProvider } from '@noodle-borg/auth';
import { afterEach, describe, expect, it } from 'vitest';
import { signExchangeAssertion } from '../src/delegated-token-exchange.js';
import { createOAuthApp } from '../src/oauth/app.js';
import {
  CONTROL_PLANE_EXCHANGE_AUDIENCE,
  CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
  type ControlPlaneExchangeDeps,
} from '../src/oauth/delegated-control-plane-token-handler.js';
import { InMemoryDeveloperGrantStore } from '../src/oauth/developer-grant.js';
import { NoodleOAuthProvider } from '../src/oauth/provider.js';
import { InMemoryOAuthStore } from '../src/oauth/store.js';
import { InMemoryTokenExchangeJtiStore } from '../src/oauth/token-exchange-jti-store.js';
import { mintOAuthAccessToken } from '../src/oauth/token-issuer.js';
import { raw } from './oauth-http-test-helpers.js';

/**
 * The inbound control-plane token exchange (ADR 0218): we implement the same target-endpoint
 * contract we ask customer token endpoints to implement, so the assertions here are forged with
 * the REAL outbound signer — the byte-for-byte requests the broker will send.
 */

const NOW_MS = Date.parse('2026-08-26T12:00:00.000Z');
const ISSUER = 'https://cloud.noodleseed.dev';
const TENANT = 'noodleseed/site-assistant/prod';
const CLIENT_ID = 'cpx_first_party';
const CLIENT_SECRET = 'cpx-secret-abcdefghijklmnopqrstuvwxyz012345';
const ASSISTANT_CLIENT = 'embed_11111111-2222-3333-4444-555555555555';

const openServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    openServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

interface ExchangeFixture {
  readonly url: string;
  readonly basic: string;
  readonly signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>;
  readonly grants: InMemoryDeveloperGrantStore;
  readonly refusedSubjects: Set<string>;
  readonly workspaces: string[];
}

async function fixture(
  overrides: Partial<ControlPlaneExchangeDeps> = {},
): Promise<ExchangeFixture> {
  const signer = await createStaticSigningKeyProvider();
  const grants = new InMemoryDeveloperGrantStore({ now: () => new Date(NOW_MS).toISOString() });
  const jti = new InMemoryTokenExchangeJtiStore();
  const refusedSubjects = new Set<string>();
  const workspaces: string[] = [];
  const provider = new NoodleOAuthProvider({
    issuer: ISSUER,
    store: new InMemoryOAuthStore(),
    signer,
    now: () => NOW_MS,
    tokenExchangeReady: true,
  });
  const deps: ControlPlaneExchangeDeps = {
    issuer: ISSUER,
    config: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, allowedTenants: [TENANT] },
    verifierKey: () => signer.verifierKey(),
    grants,
    consumeJti: (value, expiresAtMs) => jti.consume(value, expiresAtMs, NOW_MS),
    resolveSubject: async (subject) => (refusedSubjects.has(subject) ? undefined : { ok: true }),
    listAssistantClientIds: async () => [ASSISTANT_CLIENT],
    ensureWorkspace: async (identity) => {
      workspaces.push(identity.subject);
    },
    resourcePath: '/developer/assistant',
    capabilityCeiling: ['cloud:read', 'deployments:write'],
    issueAccessToken: (input) =>
      mintOAuthAccessToken({
        signer,
        issuer: ISSUER,
        ttlSeconds: input.ttlSeconds,
        identity: {
          ownerSubject: input.subject,
          ownerEmail: input.email,
          resource: input.resource,
          scope: input.scope,
          identityKind: 'platform',
          developerGrantId: input.developerGrantId,
          oauthClientId: input.oauthClientId,
        },
      }),
    ...overrides,
  };
  const server = createServer(createOAuthApp(provider, { controlPlaneExchange: deps }));
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing test address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    basic: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    signer,
    grants,
    refusedSubjects,
    workspaces,
  };
}

async function assertion(
  signer: Awaited<ReturnType<typeof createStaticSigningKeyProvider>>,
  overrides: {
    readonly audience?: string;
    readonly tenant?: string;
    readonly issuerId?: string;
    readonly subject?: string;
    readonly email?: string;
    readonly nowMs?: number;
    readonly route?: { readonly key: string; readonly fingerprint: string };
  } = {},
): Promise<string> {
  return signExchangeAssertion({
    options: {
      issuer: ISSUER,
      signer,
      tenant: overrides.tenant ?? TENANT,
      deployment: 'dep_1',
    },
    caller: {
      subject: overrides.subject ?? 'user_42',
      identityKind: 'customer',
      ...(overrides.email === '' ? {} : { email: overrides.email ?? 'founder@example.com' }),
      audience: 'https://mcp.example/site-assistant',
      customerIssuer: `urn:noodleseed:assistant-client:${overrides.issuerId ?? ASSISTANT_CLIENT}`,
    } as never,
    audience: overrides.audience ?? CONTROL_PLANE_EXCHANGE_AUDIENCE,
    // jose verifies signed assertions against the wall clock, independently of the fixture clock.
    nowMs: overrides.nowMs ?? Date.now(),
    ...(overrides.route === undefined ? {} : { route: overrides.route as never }),
  });
}

function exchange(
  url: string,
  fields: Record<string, string>,
  authorization?: string,
): ReturnType<typeof raw> {
  const params = new URLSearchParams({
    grant_type: CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    ...fields,
  });
  return raw('POST', `${url}/token`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: params.toString(),
  });
}

describe('control-plane token exchange (ADR 0218)', () => {
  it('mints a grant-bound platform token for a live first-party assertion', async () => {
    const { url, basic, signer, grants, workspaces } = await fixture();
    const response = await exchange(url, { subject_token: await assertion(signer) }, basic);

    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as Record<string, unknown>;
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(600);
    expect(body.scope).toBe('cloud:read deployments:write');

    const verify = createJwtVerifier({
      issuer: ISSUER,
      keyResolver: await signer.verifierKey(),
    });
    const verified = await verify(String(body.access_token), `${ISSUER}/developer/assistant`);
    expect(verified?.caller.subject).toBe('user_42');
    expect(verified?.caller.email).toBe('founder@example.com');
    const grant = await grants.getActive({
      clientId: CLIENT_ID,
      subject: 'user_42',
      resource: `${ISSUER}/developer/assistant`,
      at: new Date(NOW_MS).toISOString(),
    });
    // The durable, operator-revocable grant: its ceiling can never store rollback or config:write.
    expect(grant?.capabilities).toEqual(['cloud:read', 'deployments:write']);
    // Public signup mode provisions the personal workspace at mint, so the first control-plane
    // read the assistant makes already has an org to land in.
    expect(workspaces).toEqual(['user_42']);
  });

  it('reuses the active grant across repeated exchanges', async () => {
    const { url, basic, signer, grants } = await fixture();
    expect((await exchange(url, { subject_token: await assertion(signer) }, basic)).status).toBe(
      200,
    );
    expect((await exchange(url, { subject_token: await assertion(signer) }, basic)).status).toBe(
      200,
    );
    const grant = await grants.getActive({
      clientId: CLIENT_ID,
      subject: 'user_42',
      resource: `${ISSUER}/developer/assistant`,
      at: new Date(NOW_MS).toISOString(),
    });
    expect(grant).toBeDefined();
  });

  it('refuses missing or wrong client credentials', async () => {
    const { url, signer } = await fixture();
    const token = await assertion(signer);
    const anonymous = await exchange(url, { subject_token: token });
    expect(anonymous.status).toBe(401);
    const wrong = await exchange(
      url,
      { subject_token: token },
      `Basic ${Buffer.from(`${CLIENT_ID}:nope`).toString('base64')}`,
    );
    expect(wrong.status).toBe(401);
    expect(JSON.parse(wrong.text)).toMatchObject({ error: 'invalid_client' });
  });

  it('refuses an assertion whose audience is a resource URL — the forgotten-audience default', async () => {
    const { url, basic, signer } = await fixture();
    // A connector that omits `audience` defaults it to the tokenUrl, an https URL. Refusing every
    // URL audience is what keeps resource tokens and exchange assertions non-confusable.
    const response = await exchange(
      url,
      { subject_token: await assertion(signer, { audience: `${ISSUER}/token` }) },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses one of our own access tokens presented as a subject token', async () => {
    const { url, basic, signer } = await fixture();
    const accessToken = await mintOAuthAccessToken({
      signer,
      issuer: ISSUER,
      ttlSeconds: 600,
      identity: {
        ownerSubject: 'user_42',
        ownerEmail: 'founder@example.com',
        resource: `${ISSUER}/developer/cli`,
        identityKind: 'platform',
      },
    });
    const response = await exchange(url, { subject_token: accessToken }, basic);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses an audience form parameter other than the exchange URN', async () => {
    const { url, basic, signer } = await fixture();
    const response = await exchange(
      url,
      { subject_token: await assertion(signer), audience: `${ISSUER}/developer/cli` },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_target' });
  });

  it('refuses an expired assertion', async () => {
    const { url, basic, signer } = await fixture();
    // jose verifies exp against the wall clock, so expire relative to it.
    const response = await exchange(
      url,
      { subject_token: await assertion(signer, { nowMs: Date.now() - 10 * 60 * 1000 }) },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a replayed jti on the second exchange', async () => {
    const { url, basic, signer } = await fixture();
    const token = await assertion(signer);
    expect((await exchange(url, { subject_token: token }, basic)).status).toBe(200);
    const replay = await exchange(url, { subject_token: token }, basic);
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses an assertion whose tenant is not the pinned first-party tenant', async () => {
    const { url, basic, signer } = await fixture();
    const response = await exchange(
      url,
      { subject_token: await assertion(signer, { tenant: 'rival/site-assistant/prod' }) },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses an issuer that is not a live assistant client of the pinned tenant', async () => {
    const { url, basic, signer } = await fixture();
    const response = await exchange(
      url,
      { subject_token: await assertion(signer, { issuerId: 'embed_revoked' }) },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses a subject with no active platform principal', async () => {
    const { url, basic, signer, refusedSubjects } = await fixture();
    refusedSubjects.add('user_42');
    const response = await exchange(url, { subject_token: await assertion(signer) }, basic);
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('refuses scopes outside the assistant ceiling', async () => {
    const { url, basic, signer } = await fixture();
    const response = await exchange(
      url,
      { subject_token: await assertion(signer), scope: 'cloud:read deployments:rollback' },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_scope' });
  });

  it('refuses an assertion carrying a route binding', async () => {
    const { url, basic, signer } = await fixture();
    const response = await exchange(
      url,
      {
        subject_token: await assertion(signer, {
          route: { key: 'customer_api', fingerprint: 'f'.repeat(64) },
        }),
      },
      basic,
    );
    expect(response.status).toBe(400);
    expect(JSON.parse(response.text)).toMatchObject({ error: 'invalid_grant' });
  });

  it('falls through to unsupported_grant_type when the exchange is not configured', async () => {
    const signer = await createStaticSigningKeyProvider();
    const provider = new NoodleOAuthProvider({
      issuer: ISSUER,
      store: new InMemoryOAuthStore(),
      signer,
      now: () => NOW_MS,
    });
    const server = createServer(createOAuthApp(provider));
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test address');
    const response = await exchange(
      `http://127.0.0.1:${address.port}`,
      { subject_token: await assertion(signer) },
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.parse(response.text).error).not.toBe('invalid_grant');
  });

  it('advertises the grant type only when the exchange is configured', async () => {
    const signer = await createStaticSigningKeyProvider();
    const withExchange = new NoodleOAuthProvider({
      issuer: ISSUER,
      store: new InMemoryOAuthStore(),
      signer,
      tokenExchangeReady: true,
    });
    const without = new NoodleOAuthProvider({
      issuer: ISSUER,
      store: new InMemoryOAuthStore(),
      signer,
    });
    expect(withExchange.metadata().grant_types_supported).toContain(
      CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
    );
    expect(without.metadata().grant_types_supported).not.toContain(
      CONTROL_PLANE_EXCHANGE_GRANT_TYPE,
    );
  });
});

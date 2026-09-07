import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type AuthorizationCodeRecord,
  InMemoryOAuthStore,
  type OAuthStore,
  type PendingAuthorizationRecord,
  type RefreshTokenRecord,
} from '../src/oauth/store.js';
import { PostgresOAuthStore } from '../src/oauth/store-postgres.js';

const RESOURCE = 'https://borg.test/o/acme/support/mcp';
const soon = (): number => Math.floor(Date.now() / 1000) + 600;
const past = (): number => Math.floor(Date.now() / 1000) - 60;

function client(overrides: Partial<OAuthClientInformationFull> = {}): OAuthClientInformationFull {
  return {
    client_id: 'client-1',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    ...overrides,
  } as OAuthClientInformationFull;
}

function code(overrides: Partial<AuthorizationCodeRecord> = {}): AuthorizationCodeRecord {
  return {
    code: 'code-hash',
    clientId: 'client-1',
    codeChallenge: 'challenge',
    upstreamProvider: 'google',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    resource: RESOURCE,
    ownerSubject: 'google-sub-1',
    ownerLocale: 'en-GB',
    ownerTimeZone: 'Europe/London',
    expiresAt: soon(),
    ...overrides,
  };
}

function pending(overrides: Partial<PendingAuthorizationRecord> = {}): PendingAuthorizationRecord {
  return {
    state: 'state-hash',
    clientId: 'client-1',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    codeChallenge: 'challenge',
    upstreamProvider: 'google',
    resource: RESOURCE,
    expiresAt: soon(),
    ...overrides,
  };
}

function refresh(overrides: Partial<RefreshTokenRecord> = {}): RefreshTokenRecord {
  return {
    token: 'refresh-hash',
    clientId: 'client-1',
    ownerSubject: 'google-sub-1',
    ownerLocale: 'en-GB',
    ownerTimeZone: 'Europe/London',
    resource: RESOURCE,
    expiresAt: soon(),
    ...overrides,
  };
}

describe('InMemoryOAuthStore (OA-2)', () => {
  it('round-trips a DCR client', async () => {
    const store = new InMemoryOAuthStore();
    expect(await store.getClient('client-1')).toBeUndefined();
    await store.putClient(client({ client_name: 'Claude' } as Partial<OAuthClientInformationFull>));
    const got = await store.getClient('client-1');
    expect(got?.client_id).toBe('client-1');
    expect(got?.redirect_uris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('redeems an authorization code exactly once under concurrency', async () => {
    const store = new InMemoryOAuthStore();
    await store.createAuthorizationCode(code());
    // The challenge lookup is non-destructive — both concurrent token requests can read it.
    expect((await store.getAuthorizationCode('code-hash'))?.codeChallenge).toBe('challenge');
    const [a, b] = await Promise.all([
      store.redeemAuthorizationCode('code-hash'),
      store.redeemAuthorizationCode('code-hash'),
    ]);
    const redeemed = [a, b].filter((r) => r !== undefined);
    expect(redeemed).toHaveLength(1);
    expect(redeemed[0]).toMatchObject({
      ownerLocale: 'en-GB',
      ownerTimeZone: 'Europe/London',
    });
    // After redemption the code is gone (replay rejected at the challenge step).
    expect(await store.getAuthorizationCode('code-hash')).toBeUndefined();
  });

  it('rejects an expired authorization code (and still consumes it)', async () => {
    const store = new InMemoryOAuthStore();
    await store.createAuthorizationCode(code({ expiresAt: past() }));
    expect(await store.getAuthorizationCode('code-hash')).toBeUndefined();
    expect(await store.redeemAuthorizationCode('code-hash')).toBeUndefined();
  });

  it('consumes a pending authorization once; reuse and expiry yield undefined', async () => {
    const store = new InMemoryOAuthStore();
    await store.createPendingAuthorization(pending({ clientState: 'xyz' }));
    const first = await store.consumePendingAuthorization('state-hash', 'google');
    expect(first?.clientState).toBe('xyz');
    expect(await store.consumePendingAuthorization('state-hash', 'google')).toBeUndefined();

    await store.createPendingAuthorization(pending({ state: 'stale', expiresAt: past() }));
    expect(await store.consumePendingAuthorization('stale', 'google')).toBeUndefined();
  });

  it('does not consume pending authorization state when a different callback family presents it', async () => {
    const store = new InMemoryOAuthStore();
    await store.createPendingAuthorization(pending({ upstreamProvider: 'customer_firebase' }));
    await expect(
      store.consumePendingAuthorization('state-hash', 'google'),
    ).resolves.toBeUndefined();
    await expect(
      store.consumePendingAuthorization('state-hash', 'customer_firebase'),
    ).resolves.toMatchObject({
      upstreamProvider: 'customer_firebase',
    });
  });

  it('rejects an expired refresh token', async () => {
    const store = new InMemoryOAuthStore();
    await store.createRefreshToken(refresh({ expiresAt: past() }));
    expect(await store.consumeRefreshToken('refresh-hash')).toBeUndefined();
  });

  it('reads a live refresh-token identity without consuming its rotation family', async () => {
    const store = new InMemoryOAuthStore();
    await store.createRefreshToken(
      refresh({ token: 'platform-status-check', familyId: 'family-status' }),
    );

    await expect(store.getRefreshToken('platform-status-check')).resolves.toMatchObject({
      ownerSubject: 'google-sub-1',
      familyId: 'family-status',
    });
    expect(
      (
        await store.rotateRefreshToken({
          oldTokenHash: 'platform-status-check',
          clientId: 'client-1',
          newTokenHash: 'platform-status-successor',
          newExpiresAt: soon(),
          graceSeconds: 30,
          recoverySeconds: 300,
          nowSeconds: Math.floor(Date.now() / 1000),
        })
      ).status,
    ).toBe('rotated');
  });
});

/**
 * Refresh-token rotation contract (the deploy-time reconnect-loop fix —
 * docs/spec/auth-and-policy.md (refresh rotation, slice 1)). The same matrix runs against the in-memory store and,
 * when `DATABASE_URL` is set, the Postgres store, so the atomic claim SQL is exercised against a real backend.
 */
function rotationContract(getStore: () => OAuthStore): void {
  const now = 1_000_000; // fixed epoch-seconds clock — rotation decisions are driven by `nowSeconds`, not wall time
  const exp = now + 3600;
  const mk = (token: string, familyId: string, expiresAt = exp): RefreshTokenRecord => ({
    token,
    clientId: 'client-1',
    ownerSubject: 'google-sub-1',
    ownerLocale: 'en-GB',
    ownerTimeZone: 'Europe/London',
    resource: RESOURCE,
    familyId,
    expiresAt,
  });
  const rotate = (
    store: OAuthStore,
    oldTokenHash: string,
    newTokenHash: string,
    over: {
      graceSeconds?: number;
      recoverySeconds?: number;
      nowSeconds?: number;
      clientId?: string;
    } = {},
  ) =>
    store.rotateRefreshToken({
      oldTokenHash,
      clientId: over.clientId ?? 'client-1',
      newTokenHash,
      newExpiresAt: exp,
      graceSeconds: over.graceSeconds ?? 30,
      recoverySeconds: over.recoverySeconds ?? 300,
      nowSeconds: over.nowSeconds ?? now,
    });

  it('rotates a live token and yields a usable successor in the same family', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    const out = await rotate(store, 'r1', 'r2');
    expect(out.status).toBe('rotated');
    if (out.status === 'rotated') {
      expect(out.identity).toMatchObject({
        familyId: 'fam-1',
        ownerLocale: 'en-GB',
        ownerTimeZone: 'Europe/London',
      });
    }
    // The successor is itself live and rotatable.
    expect((await rotate(store, 'r2', 'r3')).status).toBe('rotated');
  });

  it('treats reuse within the grace window as benign and keeps the family intact', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    expect((await rotate(store, 'r1', 'r2')).status).toBe('rotated');
    // A racing/retried refresh of the same old token, 10s later, inside the 30s window.
    expect((await rotate(store, 'r1', 'r3', { nowSeconds: now + 10 })).status).toBe('grace');
    // The first successor still works — the family was not revoked.
    expect((await rotate(store, 'r2', 'r4', { nowSeconds: now + 10 })).status).toBe('rotated');
  });

  it('resolves concurrent rotation of the same token without invalid_grant', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    const [a, b] = await Promise.all([rotate(store, 'r1', 'r2'), rotate(store, 'r1', 'r3')]);
    // Exactly one wins the claim; the other lands in the grace window — neither is rejected.
    expect([a.status, b.status].sort()).toEqual(['grace', 'rotated']);
  });

  it('revokes the whole family on reuse outside the grace window', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    expect((await rotate(store, 'r1', 'r2')).status).toBe('rotated');
    expect((await rotate(store, 'r1', 'r3', { nowSeconds: now + 360 })).status).toBe('reuse');
    // The live successor is revoked along with the rest of the family.
    expect((await rotate(store, 'r2', 'r4', { nowSeconds: now + 360 })).status).toBe('unknown');
  });

  it('recovers an out-of-grace retry when the successor was never used', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    expect((await rotate(store, 'r1', 'r2')).status).toBe('rotated');

    const recovered = await rotate(store, 'r1', 'r3', { nowSeconds: now + 60 });
    expect(recovered.status).toBe('recovered');
    if (recovered.status === 'recovered') expect(recovered.identity.familyId).toBe('fam-1');

    // The lost successor is invalidated so there is one recovered head to continue from.
    expect((await rotate(store, 'r2', 'r4', { nowSeconds: now + 60 })).status).toBe('unknown');
    expect((await rotate(store, 'r3', 'r5', { nowSeconds: now + 60 })).status).toBe('rotated');
  });

  it('treats an old-token replay as theft once its successor has been used', async () => {
    const store = getStore();
    await store.createRefreshToken(mk('r1', 'fam-1'));
    expect((await rotate(store, 'r1', 'r2')).status).toBe('rotated');
    expect((await rotate(store, 'r2', 'r3', { nowSeconds: now + 60 })).status).toBe('rotated');

    expect((await rotate(store, 'r1', 'r4', { nowSeconds: now + 120 })).status).toBe('reuse');
    expect((await rotate(store, 'r3', 'r5', { nowSeconds: now + 120 })).status).toBe('unknown');
  });

  it('reports unknown for an absent, wrong-client, or expired token', async () => {
    const store = getStore();
    expect((await rotate(store, 'nope', 'x')).status).toBe('unknown');
    await store.createRefreshToken(mk('r1', 'fam-1'));
    expect((await rotate(store, 'r1', 'x', { clientId: 'other' })).status).toBe('unknown');
    await store.createRefreshToken(mk('r5', 'fam-5', now - 1));
    expect((await rotate(store, 'r5', 'x')).status).toBe('unknown');
  });
}

/**
 * Remembered-consent contract (the ChatGPT re-auth-loop mitigation — standard OAuth consent persistence). A
 * grant is per `(clientId, ownerSubject, resource)`, idempotent, and never leaks across any of the three.
 */
function consentGrantContract(getStore: () => OAuthStore): void {
  it('remembers a consent grant per (client, subject, resource), idempotently and scoped', async () => {
    const store = getStore();
    expect(await store.hasConsentGrant('client-1', 'google-sub-1', RESOURCE, 'platform')).toBe(
      false,
    );
    await store.createConsentGrant({
      clientId: 'client-1',
      ownerSubject: 'google-sub-1',
      resource: RESOURCE,
      identityKind: 'platform',
    });
    await store.createConsentGrant({
      clientId: 'client-1',
      ownerSubject: 'google-sub-1',
      resource: RESOURCE,
      identityKind: 'platform',
    });
    expect(await store.hasConsentGrant('client-1', 'google-sub-1', RESOURCE, 'platform')).toBe(
      true,
    );
    expect(await store.hasConsentGrant('client-1', 'google-sub-1', RESOURCE, 'customer')).toBe(
      false,
    );
    await store.createConsentGrant({
      clientId: 'client-1',
      ownerSubject: 'google-sub-1',
      resource: RESOURCE,
      identityKind: 'customer',
    });
    expect(await store.hasConsentGrant('client-1', 'google-sub-1', RESOURCE, 'platform')).toBe(
      true,
    );
    expect(await store.hasConsentGrant('client-1', 'google-sub-1', RESOURCE, 'customer')).toBe(
      true,
    );
    // Scoped: a different client, subject, or resource has no grant (confused-deputy guard).
    expect(await store.hasConsentGrant('other', 'google-sub-1', RESOURCE, 'platform')).toBe(false);
    expect(await store.hasConsentGrant('client-1', 'other-sub', RESOURCE, 'platform')).toBe(false);
    expect(
      await store.hasConsentGrant(
        'client-1',
        'google-sub-1',
        'https://borg.test/o/acme/other/mcp',
        'platform',
      ),
    ).toBe(false);
  });
}

function identityPreferencesContract(getStore: () => OAuthStore): void {
  it('round-trips verified preferences through codes and refresh successors', async () => {
    const store = getStore();
    await store.createAuthorizationCode(code({ code: 'preference-code' }));
    await expect(store.redeemAuthorizationCode('preference-code')).resolves.toMatchObject({
      ownerLocale: 'en-GB',
      ownerTimeZone: 'Europe/London',
    });

    await store.createRefreshToken(
      refresh({ token: 'preference-r1', familyId: 'preference-family' }),
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rotation = await store.rotateRefreshToken({
      oldTokenHash: 'preference-r1',
      clientId: 'client-1',
      newTokenHash: 'preference-r2',
      newExpiresAt: nowSeconds + 3600,
      graceSeconds: 30,
      recoverySeconds: 300,
      nowSeconds,
    });
    expect(rotation).toMatchObject({
      status: 'rotated',
      identity: { ownerLocale: 'en-GB', ownerTimeZone: 'Europe/London' },
    });
    await expect(store.consumeRefreshToken('preference-r2')).resolves.toMatchObject({
      ownerLocale: 'en-GB',
      ownerTimeZone: 'Europe/London',
    });
  });
}

function authorizationClaimsContract(getStore: () => OAuthStore): void {
  it('round-trips trusted roles, upstream expiry, and customer issuer through codes and refresh successors', async () => {
    const store = getStore();
    const upstreamExpiresAt = soon();
    const customerIssuer = 'https://login.microsoftonline.com/tenant-1/v2.0';
    await store.createAuthorizationCode(
      code({
        code: 'authorization-claims-code',
        roles: ['admin', 'support'],
        upstreamExpiresAt,
        identityKind: 'customer',
        identityProvider: 'microsoft',
        customerIssuer,
      }),
    );
    await expect(store.redeemAuthorizationCode('authorization-claims-code')).resolves.toMatchObject(
      {
        roles: ['admin', 'support'],
        upstreamExpiresAt,
        customerIssuer,
      },
    );

    await store.createRefreshToken(
      refresh({
        token: 'authorization-claims-r1',
        familyId: 'authorization-claims-family',
        roles: ['admin', 'support'],
        upstreamExpiresAt,
        identityKind: 'customer',
        identityProvider: 'microsoft',
        customerIssuer,
      }),
    );
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const rotation = await store.rotateRefreshToken({
      oldTokenHash: 'authorization-claims-r1',
      clientId: 'client-1',
      newTokenHash: 'authorization-claims-r2',
      newExpiresAt: upstreamExpiresAt,
      graceSeconds: 30,
      recoverySeconds: 300,
      nowSeconds,
    });
    expect(rotation).toMatchObject({
      status: 'rotated',
      identity: {
        roles: ['admin', 'support'],
        upstreamExpiresAt,
        customerIssuer,
      },
    });
    await expect(store.consumeRefreshToken('authorization-claims-r2')).resolves.toMatchObject({
      roles: ['admin', 'support'],
      upstreamExpiresAt,
      customerIssuer,
    });
  });
}

function developerGrantContract(getStore: () => OAuthStore): void {
  it('round-trips the opaque developer grant through codes and refresh successors', async () => {
    const store = getStore();
    await store.createAuthorizationCode(
      code({ code: 'developer-code', developerGrantId: 'grant-1' }),
    );
    await expect(store.redeemAuthorizationCode('developer-code')).resolves.toMatchObject({
      clientId: 'client-1',
      developerGrantId: 'grant-1',
    });

    await store.createRefreshToken(
      refresh({
        token: 'developer-r1',
        familyId: 'developer-family',
        developerGrantId: 'grant-1',
      }),
    );
    const nowSeconds = Math.floor(Date.now() / 1000);
    const rotation = await store.rotateRefreshToken({
      oldTokenHash: 'developer-r1',
      clientId: 'client-1',
      newTokenHash: 'developer-r2',
      newExpiresAt: nowSeconds + 3600,
      graceSeconds: 30,
      recoverySeconds: 300,
      nowSeconds,
    });
    expect(rotation).toMatchObject({
      status: 'rotated',
      identity: { developerGrantId: 'grant-1' },
    });
    await expect(store.consumeRefreshToken('developer-r2')).resolves.toMatchObject({
      clientId: 'client-1',
      developerGrantId: 'grant-1',
    });
  });
}

function deviceAuthorizationContract(getStore: () => OAuthStore): void {
  it('atomically moves a device request from pending through approval to single-use completion', async () => {
    const store = getStore();
    const now = Math.floor(Date.now() / 1000);
    await store.createDeviceAuthorization({
      deviceCode: 'device-hash',
      userCode: 'user-hash',
      clientId: 'client-1',
      resource: RESOURCE,
      scope: 'openid email',
      status: 'pending',
      expiresAt: now + 600,
      nextPollAt: now,
      intervalSeconds: 5,
    });
    await expect(store.getDeviceAuthorizationByUserCode('user-hash')).resolves.toMatchObject({
      deviceCode: 'device-hash',
      status: 'pending',
    });
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'device-hash',
        clientId: 'other-client',
        nowSeconds: now,
      }),
    ).resolves.toEqual({ status: 'invalid_grant' });
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'device-hash',
        clientId: 'client-1',
        nowSeconds: now,
      }),
    ).resolves.toEqual({ status: 'authorization_pending' });
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'device-hash',
        clientId: 'client-1',
        nowSeconds: now + 1,
      }),
    ).resolves.toEqual({ status: 'slow_down' });
    await expect(
      store.approveDeviceAuthorization('device-hash', {
        ownerSubject: 'google-sub-1',
        ownerEmail: 'owner@example.test',
        ownerLocale: 'en-GB',
        ownerTimeZone: 'Europe/London',
        identityKind: 'customer',
        identityProvider: 'microsoft',
        customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
        developerGrantId: 'grant-1',
      }),
    ).resolves.toBe(true);
    const approved = await store.pollDeviceAuthorization({
      deviceCode: 'device-hash',
      clientId: 'client-1',
      resource: RESOURCE,
      nowSeconds: now + 1,
    });
    expect(approved).toMatchObject({
      status: 'approved',
      record: {
        ownerSubject: 'google-sub-1',
        ownerLocale: 'en-GB',
        ownerTimeZone: 'Europe/London',
        customerIssuer: 'https://login.microsoftonline.com/tenant-1/v2.0',
        developerGrantId: 'grant-1',
      },
    });
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'device-hash',
        clientId: 'client-1',
        resource: RESOURCE,
        nowSeconds: now + 1,
      }),
    ).resolves.toMatchObject({ status: 'approved' });
    const completions = await Promise.all([
      store.completeDeviceTokenIssuance('device-hash', 'client-1'),
      store.completeDeviceTokenIssuance('device-hash', 'client-1'),
    ]);
    expect(completions.sort()).toEqual([false, true]);
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'device-hash',
        clientId: 'client-1',
        nowSeconds: now + 1,
      }),
    ).resolves.toEqual({ status: 'expired_token' });
  });

  it('consumes browser state once and surfaces a denied device request once', async () => {
    const store = getStore();
    const now = Math.floor(Date.now() / 1000);
    await store.createDeviceAuthorization({
      deviceCode: 'denied-device',
      userCode: 'denied-user',
      clientId: 'client-1',
      resource: RESOURCE,
      status: 'pending',
      expiresAt: now + 600,
      nextPollAt: now,
      intervalSeconds: 5,
    });
    await store.createDeviceBrowserSession({
      state: 'browser-state',
      deviceCode: 'denied-device',
      clientId: 'client-1',
      resource: RESOURCE,
      codeChallenge: 'challenge',
      expiresAt: now + 600,
    });
    await expect(store.consumeDeviceBrowserSession('browser-state')).resolves.toMatchObject({
      deviceCode: 'denied-device',
    });
    await expect(store.consumeDeviceBrowserSession('browser-state')).resolves.toBeUndefined();
    await expect(store.denyDeviceAuthorization('denied-device')).resolves.toBe(true);
    await expect(
      store.pollDeviceAuthorization({
        deviceCode: 'denied-device',
        clientId: 'client-1',
        nowSeconds: now,
      }),
    ).resolves.toEqual({ status: 'access_denied' });
  });
}

describe('InMemoryOAuthStore rotation', () => {
  rotationContract(() => new InMemoryOAuthStore());
});

describe('InMemoryOAuthStore consent grants', () => {
  consentGrantContract(() => new InMemoryOAuthStore());
});

describe('InMemoryOAuthStore identity preferences', () => {
  identityPreferencesContract(() => new InMemoryOAuthStore());
});

describe('InMemoryOAuthStore authorization claims', () => {
  authorizationClaimsContract(() => new InMemoryOAuthStore());
});

describe('InMemoryOAuthStore developer grants', () => {
  developerGrantContract(() => new InMemoryOAuthStore());
});

describe('InMemoryOAuthStore device authorization', () => {
  deviceAuthorizationContract(() => new InMemoryOAuthStore());
});

describe.skipIf(!(process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL))(
  'PostgresOAuthStore (DATABASE_URL)',
  () => {
    let pool: Pool;
    let store: PostgresOAuthStore;

    beforeAll(async () => {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL,
      });
      store = new PostgresOAuthStore(pool);
      await store.ensureSchema();
    });

    beforeEach(async () => {
      await pool.query('TRUNCATE oauth_refresh_tokens');
      await pool.query('TRUNCATE oauth_authorization_codes');
      await pool.query('TRUNCATE oauth_consent_grant_provenance');
      await pool.query('TRUNCATE oauth_consent_grants');
      await pool.query('TRUNCATE oauth_device_authorizations');
      await pool.query('TRUNCATE oauth_device_browser_sessions');
    });

    afterAll(async () => {
      await pool.end();
    });

    // Same store across cases; tables are truncated before each test for isolation.
    rotationContract(() => store);
    consentGrantContract(() => store);
    authorizationClaimsContract(() => store);
    it('classifies legacy consent as platform while old and typed writers coexist across schema reruns', async () => {
      await pool.query(
        `INSERT INTO oauth_consent_grants (client_id, owner_subject, resource)
       VALUES ('rolling-client', 'same-subject', $1)`,
        [RESOURCE],
      );

      await expect(
        store.hasConsentGrant('rolling-client', 'same-subject', RESOURCE, 'platform'),
      ).resolves.toBe(true);
      await expect(
        store.hasConsentGrant('rolling-client', 'same-subject', RESOURCE, 'customer'),
      ).resolves.toBe(false);
      await store.createConsentGrant({
        clientId: 'rolling-client',
        ownerSubject: 'same-subject',
        resource: RESOURCE,
        identityKind: 'platform',
      });
      await store.createConsentGrant({
        clientId: 'rolling-client',
        ownerSubject: 'same-subject',
        resource: RESOURCE,
        identityKind: 'customer',
      });
      await store.ensureSchema();
      await pool.query(
        `INSERT INTO oauth_consent_grants (client_id, owner_subject, resource)
       VALUES ('old-writer-client', 'old-writer-subject', $1)`,
        [RESOURCE],
      );

      await expect(
        pool.query<{ readonly legacy_count: number; readonly typed_count: number }>(
          `SELECT
           (SELECT count(*)::int FROM oauth_consent_grants
             WHERE client_id = 'rolling-client' AND owner_subject = 'same-subject') AS legacy_count,
           (SELECT count(*)::int FROM oauth_consent_grant_provenance
             WHERE client_id = 'rolling-client' AND owner_subject = 'same-subject') AS typed_count`,
        ),
      ).resolves.toMatchObject({
        rows: [{ legacy_count: 1, typed_count: 2 }],
      });
      await expect(
        store.hasConsentGrant('old-writer-client', 'old-writer-subject', RESOURCE, 'platform'),
      ).resolves.toBe(true);
    });
    identityPreferencesContract(() => store);
    developerGrantContract(() => store);
    deviceAuthorizationContract(() => store);
  },
);

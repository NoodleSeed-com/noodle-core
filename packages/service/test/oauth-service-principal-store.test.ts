import { exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalCredentialRecord,
} from '../src/oauth/service-principal-store.js';

const NOW = '2026-08-03T12:00:00.000Z';
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { modulusLength: 2048 });
  publicJwk = await exportJWK(pair.publicKey);
});

function storeAt(iso = NOW): InMemoryServicePrincipalStore {
  return new InMemoryServicePrincipalStore({ now: () => new Date(iso) });
}

async function principal(store: InMemoryServicePrincipalStore, org = 'acme') {
  return store.createPrincipal({ org, name: 'nightly sync', actorSubject: 'usr_1' });
}

async function secretCredential(
  store: InMemoryServicePrincipalStore,
  principalId: string,
  index: number,
  options: { org?: string; expiresAt?: string } = {},
): Promise<ServicePrincipalCredentialRecord> {
  return store.createCredential({
    principalId,
    org: options.org ?? 'acme',
    actorSubject: 'usr_1',
    kind: 'client_secret',
    label: `secret ${index}`,
    secretDigest: digestClientSecret(`secret-${index}`),
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  });
}

describe('in-memory service-principal lifecycle', () => {
  it('creates an organization principal and a normalized app/environment grant', async () => {
    const store = storeAt();
    const created = await principal(store);
    const grant = await store.createGrant({
      principalId: created.principalId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      scopes: ['todos.write', 'todos.read', 'todos.write'],
      actorSubject: 'usr_1',
    });

    expect(created).toMatchObject({
      principalId: expect.stringMatching(/^spn_[0-9a-f-]{36}$/),
      org: 'acme',
      name: 'nightly sync',
      status: 'active',
      createdAt: NOW,
    });
    expect(grant).toMatchObject({
      grantId: expect.stringMatching(/^spg_[0-9a-f-]{36}$/),
      scopes: ['todos.read', 'todos.write'],
      status: 'active',
    });
  });

  it.each([
    '',
    ' '.repeat(3),
    'x'.repeat(81),
    'line\nbreak',
  ])('rejects invalid principal names', async (name) => {
    await expect(
      storeAt().createPrincipal({ org: 'acme', name, actorSubject: 'usr_1' }),
    ).rejects.toThrow(/name/i);
  });

  it('rejects invalid and excessive scopes', async () => {
    const store = storeAt();
    const created = await principal(store);
    const input = {
      principalId: created.principalId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      actorSubject: 'usr_1',
    };

    await expect(store.createGrant({ ...input, scopes: ['x'.repeat(129)] })).rejects.toThrow(
      /scope/i,
    );
    await expect(
      store.createGrant({
        ...input,
        scopes: Array.from({ length: 65 }, (_, index) => `scope.${index}`),
      }),
    ).rejects.toThrow(/64/);
  });

  it('prevents cross-organization mutation and grant creation', async () => {
    const store = storeAt();
    const created = await principal(store);

    await expect(
      store.createGrant({
        principalId: created.principalId,
        org: 'other',
        app: 'todoist',
        environment: 'prod',
        scopes: [],
        actorSubject: 'usr_2',
      }),
    ).rejects.toThrow(/organization/i);
    await expect(secretCredential(store, created.principalId, 1, { org: 'other' })).rejects.toThrow(
      /organization/i,
    );
    await expect(
      store.getPrincipal({ principalId: created.principalId, org: 'other' }),
    ).resolves.toBeUndefined();
  });

  it('allows one active grant per target and replacement only after revocation', async () => {
    const store = storeAt();
    const created = await principal(store);
    const grantInput = {
      principalId: created.principalId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      scopes: ['todos.read'],
      actorSubject: 'usr_1',
    };
    const original = await store.createGrant(grantInput);

    await expect(store.createGrant(grantInput)).rejects.toThrow(/active grant/i);
    await expect(
      store.revokeGrant({
        principalId: created.principalId,
        grantId: original.grantId,
        org: 'acme',
        actorSubject: 'usr_1',
      }),
    ).resolves.toBe(true);
    await expect(store.createGrant(grantInput)).resolves.toMatchObject({ status: 'active' });
  });

  it('supports five overlapping credentials per kind and frees capacity after revocation', async () => {
    const store = storeAt();
    const created = await principal(store);
    const secrets: ServicePrincipalCredentialRecord[] = [];
    for (let index = 0; index < 5; index += 1) {
      secrets.push(await secretCredential(store, created.principalId, index));
    }
    for (let index = 0; index < 5; index += 1) {
      await store.createCredential({
        principalId: created.principalId,
        org: 'acme',
        actorSubject: 'usr_1',
        kind: 'public_jwk',
        label: `key ${index}`,
        algorithm: 'RS256',
        publicJwk: { ...publicJwk, kid: `key-${index}` },
      });
    }

    await expect(secretCredential(store, created.principalId, 6)).rejects.toThrow(/five active/i);
    await expect(
      store.createCredential({
        principalId: created.principalId,
        org: 'acme',
        actorSubject: 'usr_1',
        kind: 'public_jwk',
        label: 'key 6',
        algorithm: 'RS256',
        publicJwk,
      }),
    ).rejects.toThrow(/five active/i);

    await store.revokeCredential({
      principalId: created.principalId,
      credentialId: secrets[0]?.credentialId ?? '',
      org: 'acme',
      actorSubject: 'usr_1',
    });
    await expect(secretCredential(store, created.principalId, 7)).resolves.toMatchObject({
      status: 'active',
    });
  });

  it('omits secret digests and public keys from lifecycle views', async () => {
    const store = storeAt();
    const created = await principal(store);
    const secret = await secretCredential(store, created.principalId, 1);
    await store.createCredential({
      principalId: created.principalId,
      org: 'acme',
      actorSubject: 'usr_1',
      kind: 'public_jwk',
      label: 'signer',
      algorithm: 'RS256',
      publicJwk,
    });

    const view = await store.getPrincipal({ principalId: created.principalId, org: 'acme' });
    expect(view?.credentials).toHaveLength(2);
    expect(JSON.stringify(view)).not.toContain(digestClientSecret('secret-1'));
    expect(JSON.stringify(view)).not.toContain(String(publicJwk.n));
    expect(secret).not.toHaveProperty('secretDigest');
    expect(secret).not.toHaveProperty('publicJwk');
  });

  it('excludes expired credentials and revokes principals idempotently', async () => {
    const store = storeAt();
    const created = await principal(store);
    await secretCredential(store, created.principalId, 1, {
      expiresAt: '2026-08-03T12:01:00.000Z',
    });

    await expect(
      store.loadActiveClient(created.principalId, Date.parse('2026-08-03T12:02:00.000Z')),
    ).resolves.toMatchObject({ credentials: [] });
    const mutation = {
      principalId: created.principalId,
      org: 'acme',
      actorSubject: 'usr_1',
    };
    await expect(store.revokePrincipal(mutation)).resolves.toBe(true);
    await expect(store.revokePrincipal(mutation)).resolves.toBe(true);
    await expect(
      store.loadActiveClient(created.principalId, Date.parse(NOW)),
    ).resolves.toBeUndefined();
    await expect(
      store.createGrant({
        ...mutation,
        app: 'todoist',
        environment: 'prod',
        scopes: [],
      }),
    ).rejects.toThrow(/revoked/i);
  });

  it('validates a live binding and invalidates it immediately on credential revocation', async () => {
    const store = storeAt();
    const created = await principal(store);
    const grant = await store.createGrant({
      principalId: created.principalId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      scopes: ['todos.read'],
      actorSubject: 'usr_1',
    });
    const credential = await secretCredential(store, created.principalId, 1);
    const binding = {
      principalId: created.principalId,
      grantId: grant.grantId,
      credentialId: credential.credentialId,
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
      now: Date.parse(NOW),
    };

    await expect(store.validateAccessBinding(binding)).resolves.toBe(true);
    await store.revokeCredential({
      principalId: created.principalId,
      credentialId: credential.credentialId,
      org: 'acme',
      actorSubject: 'usr_1',
    });
    await expect(store.validateAccessBinding(binding)).resolves.toBe(false);
  });

  it('atomically consumes an assertion jti once per credential', async () => {
    const store = storeAt();
    const created = await principal(store);
    const credential = await secretCredential(store, created.principalId, 1);
    const input = {
      credentialId: credential.credentialId,
      jti: 'assertion-1',
      expiresAt: Date.parse('2026-08-03T12:05:00.000Z'),
      now: Date.parse(NOW),
    };

    const results = await Promise.all([
      store.consumeAssertionJti(input),
      store.consumeAssertionJti(input),
    ]);
    expect(results.sort()).toEqual([false, true]);
  });

  it('isolates principal listings by organization', async () => {
    const store = storeAt();
    await principal(store, 'acme');
    await principal(store, 'other');

    await expect(store.listPrincipals('acme')).resolves.toEqual([
      expect.objectContaining({ org: 'acme' }),
    ]);
  });
});

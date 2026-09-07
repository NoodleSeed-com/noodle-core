import type { TokenVerifier, VerifiedTokenEnvelope } from '@noodle-borg/auth';
import type { PlatformPrincipalResolver } from '@noodle-borg/module';
import { describe, expect, it, vi } from 'vitest';
import { guardPlatformAccessTokenVerifier } from '../src/oauth/principal-status.js';
import { digestClientSecret } from '../src/oauth/service-principal-credentials.js';
import { guardServicePrincipalAccessTokenVerifier } from '../src/oauth/service-principal-guard.js';
import {
  InMemoryServicePrincipalStore,
  type ServicePrincipalStore,
} from '../src/oauth/service-principal-store.js';

const NOW = Date.parse('2026-08-03T12:00:00.000Z');
const RESOURCE = 'https://acme.cloud.noodleseed.dev/todoist/mcp';

describe('service-principal access-token live guard', () => {
  it('verifies cryptography first and never reads machine state for invalid, platform, or customer tokens', async () => {
    const validateAccessBinding = vi.fn();
    const store = { validateAccessBinding } as unknown as ServicePrincipalStore;
    const resolveResource = vi.fn();

    for (const verification of [
      null,
      envelope('human-1', 'platform'),
      envelope('customer-1', 'customer'),
    ]) {
      const verifier = vi.fn<TokenVerifier>().mockResolvedValue(verification);
      const guarded = guardServicePrincipalAccessTokenVerifier(
        verifier,
        store,
        resolveResource,
        () => NOW,
      );
      expect(await guarded('raw-token', RESOURCE)).toEqual(verification);
      expect(verifier).toHaveBeenCalledWith('raw-token', RESOURCE);
    }
    expect(resolveResource).not.toHaveBeenCalled();
    expect(validateAccessBinding).not.toHaveBeenCalled();
  });

  it('reloads the exact binding on every request and strips private IDs from the result', async () => {
    const fixture = await activeFixture();
    const verifier = serviceVerifier(fixture);
    const resolveResource = vi.fn().mockResolvedValue({
      org: 'acme',
      app: 'todoist',
      environment: 'prod',
    });
    const guarded = guardServicePrincipalAccessTokenVerifier(
      verifier,
      fixture.store,
      resolveResource,
      () => NOW,
    );

    const first = await guarded('raw-token', RESOURCE);
    const second = await guarded('raw-token', RESOURCE);
    expect(first).toEqual({
      caller: expect.objectContaining({
        subject: fixture.principalId,
        identityKind: 'service',
        roles: [],
      }),
    });
    expect(first).not.toHaveProperty('servicePrincipal');
    expect(resolveResource).toHaveBeenCalledTimes(2);
    expect(second).toEqual(first);
  });

  it.each([
    'principal',
    'grant',
    'credential',
  ] as const)('invalidates an already-issued token immediately after %s revocation', async (target) => {
    const fixture = await activeFixture();
    const guarded = guardServicePrincipalAccessTokenVerifier(
      serviceVerifier(fixture),
      fixture.store,
      async () => ({ org: 'acme', app: 'todoist', environment: 'prod' }),
      () => NOW,
    );
    expect(await guarded('raw-token', RESOURCE)).not.toBeNull();
    if (target === 'principal') {
      await fixture.store.revokePrincipal({
        principalId: fixture.principalId,
        org: 'acme',
        actorSubject: 'human-1',
      });
    } else if (target === 'grant') {
      await fixture.store.revokeGrant({
        principalId: fixture.principalId,
        grantId: fixture.grantId,
        org: 'acme',
        actorSubject: 'human-1',
      });
    } else {
      await fixture.store.revokeCredential({
        principalId: fixture.principalId,
        credentialId: fixture.credentialId,
        org: 'acme',
        actorSubject: 'human-1',
      });
    }
    expect(await guarded('raw-token', RESOURCE)).toBeNull();
  });

  it('fails closed for missing bindings, unavailable state, resource mismatch, and store errors', async () => {
    const fixture = await activeFixture();
    const serviceWithoutBinding: TokenVerifier = async () =>
      envelope(fixture.principalId, 'service');
    await expect(
      guardServicePrincipalAccessTokenVerifier(
        serviceWithoutBinding,
        fixture.store,
        async () => ({ org: 'acme', app: 'todoist', environment: 'prod' }),
        () => NOW,
      )('token', RESOURCE),
    ).resolves.toBeNull();
    await expect(
      guardServicePrincipalAccessTokenVerifier(
        serviceVerifier(fixture),
        undefined,
        async () => ({ org: 'acme', app: 'todoist', environment: 'prod' }),
        () => NOW,
      )('token', RESOURCE),
    ).resolves.toBeNull();
    await expect(
      guardServicePrincipalAccessTokenVerifier(
        serviceVerifier(fixture),
        fixture.store,
        async () => undefined,
        () => NOW,
      )('token', RESOURCE),
    ).resolves.toBeNull();
    const failingStore = {
      validateAccessBinding: () => Promise.reject(new Error('postgres unavailable')),
    } as unknown as ServicePrincipalStore;
    await expect(
      guardServicePrincipalAccessTokenVerifier(
        serviceVerifier(fixture),
        failingStore,
        async () => ({ org: 'acme', app: 'todoist', environment: 'prod' }),
        () => NOW,
      )('token', RESOURCE),
    ).resolves.toBeNull();
  });

  it('keeps service identities out of the platform suspension resolver', async () => {
    const resolver = { resolveExisting: vi.fn() } as unknown as PlatformPrincipalResolver;
    const serviceVerification = envelope('spn_00000000-0000-4000-8000-000000000001', 'service');
    const guarded = guardPlatformAccessTokenVerifier(async () => serviceVerification, resolver);
    await expect(guarded('token', RESOURCE)).resolves.toEqual(serviceVerification);
    expect(resolver.resolveExisting).not.toHaveBeenCalled();
  });
});

function envelope(
  subject: string,
  identityKind: 'platform' | 'customer' | 'service',
): VerifiedTokenEnvelope {
  return {
    caller: { subject, scopes: [], roles: [], identityKind },
  };
}

async function activeFixture() {
  const store = new InMemoryServicePrincipalStore({ now: () => new Date(NOW) });
  const principal = await store.createPrincipal({
    org: 'acme',
    name: 'nightly',
    actorSubject: 'human-1',
  });
  const grant = await store.createGrant({
    principalId: principal.principalId,
    org: 'acme',
    app: 'todoist',
    environment: 'prod',
    scopes: ['todos.read'],
    actorSubject: 'human-1',
  });
  const credential = await store.createCredential({
    principalId: principal.principalId,
    org: 'acme',
    kind: 'client_secret',
    label: 'primary',
    secretDigest: digestClientSecret('abcdefghijklmnopqrstuvwxyzABCDEFGH123456789'),
    actorSubject: 'human-1',
  });
  return {
    store,
    principalId: principal.principalId,
    grantId: grant.grantId,
    credentialId: credential.credentialId,
  };
}

function serviceVerifier(fixture: {
  principalId: string;
  grantId: string;
  credentialId: string;
}): TokenVerifier {
  return async () => ({
    caller: {
      subject: fixture.principalId,
      scopes: ['todos.read'],
      roles: [],
      identityKind: 'service',
    },
    servicePrincipal: {
      grantId: fixture.grantId,
      credentialId: fixture.credentialId,
    },
  });
}

import { describe, expect, it } from 'vitest';
import { InMemoryGoogleWorkloadIdentityStore } from '../src/google-workload-identity-store.js';

const tenant = { org: 'acme', app: 'analytics', env: 'prod' };

describe('Google workload identity lifecycle store', () => {
  it('prepares one stable active environment identity idempotently', async () => {
    let sequence = 0;
    const store = new InMemoryGoogleWorkloadIdentityStore({
      now: () => new Date('2026-07-23T12:00:00.000Z'),
      randomId: () => `identity-${++sequence}`,
    });

    const first = await store.prepare({
      ...tenant,
      actorSubject: 'owner-1',
      actorEmail: 'owner@example.com',
    });
    const second = await store.prepare({
      ...tenant,
      actorSubject: 'owner-2',
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: 'identity-1',
      revision: 'identity-1',
      tenantId: 'acme/analytics/prod',
      environmentId: 'prod',
      subject: 'noodle:google-workload:identity-1',
      active: true,
      createdAt: '2026-07-23T12:00:00.000Z',
      updatedAt: '2026-07-23T12:00:00.000Z',
      createdBySubject: 'owner-1',
      createdByEmail: 'owner@example.com',
    });
    await expect(
      store.resolve({ tenantId: 'acme/analytics/prod', deploymentId: 'any-deployment' }),
    ).resolves.toEqual(first);
  });

  it('revokes immediately and creates a new subject only on explicit re-prepare', async () => {
    let sequence = 0;
    const store = new InMemoryGoogleWorkloadIdentityStore({
      randomId: () => `identity-${++sequence}`,
    });
    const prepared = await store.prepare({ ...tenant, actorSubject: 'owner-1' });

    const revoked = await store.revoke({ ...tenant, actorSubject: 'owner-2' });
    expect(revoked).toMatchObject({
      id: prepared.id,
      active: false,
      revokedBySubject: 'owner-2',
    });
    await expect(
      store.resolve({ tenantId: 'acme/analytics/prod', deploymentId: 'any-deployment' }),
    ).resolves.toMatchObject({ active: false });
    await expect(store.revoke({ ...tenant, actorSubject: 'owner-2' })).resolves.toEqual(revoked);

    const replacement = await store.prepare({ ...tenant, actorSubject: 'owner-3' });
    expect(replacement.id).toBe('identity-2');
    expect(replacement.subject).not.toBe(prepared.subject);
    expect(replacement.active).toBe(true);
  });

  it('isolates exact org/app/environment keys', async () => {
    let sequence = 0;
    const store = new InMemoryGoogleWorkloadIdentityStore({
      randomId: () => `identity-${++sequence}`,
    });
    await store.prepare({ ...tenant, actorSubject: 'owner-1' });
    await store.prepare({ ...tenant, env: 'staging', actorSubject: 'owner-1' });

    await expect(store.get(tenant)).resolves.toMatchObject({ id: 'identity-1' });
    await expect(store.get({ ...tenant, env: 'staging' })).resolves.toMatchObject({
      id: 'identity-2',
    });
    await expect(store.get({ ...tenant, app: 'other' })).resolves.toBeUndefined();
  });

  it('rejects control characters in lifecycle actors', async () => {
    const store = new InMemoryGoogleWorkloadIdentityStore();
    expect(() => store.prepare({ ...tenant, actorSubject: 'owner\u0000injected' })).toThrow(
      'invalid workload identity actor',
    );
  });
});

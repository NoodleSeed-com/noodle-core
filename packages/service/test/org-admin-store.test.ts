import { describe, expect, it } from 'vitest';
import { InMemoryControlPlaneStore } from '../src/index.js';

/**
 * Store-layer contract for org administration (issue #267): invitation listing/revocation, org renames,
 * and member role changes. The Postgres adapter mirrors these behaviors in `store-postgres.test.ts`.
 */

function storeAt(iso: string): { store: InMemoryControlPlaneStore; tick: (next: string) => void } {
  let current = new Date(iso);
  const store = new InMemoryControlPlaneStore({ now: () => current });
  return {
    store,
    tick: (next: string) => {
      current = new Date(next);
    },
  };
}

const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

describe('owned org creation', () => {
  it('creates the first owner and does not let a later creator claim an owned org', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrgWithOwner({
      slug: 'acme',
      displayName: 'Acme',
      owner: { subject: 'sub-first', email: 'first@example.com' },
    });
    await store.createOrgWithOwner({
      slug: 'acme',
      owner: { subject: 'sub-second', email: 'second@example.com' },
    });

    expect(await store.listOrgMembers('acme')).toEqual([
      expect.objectContaining({ subject: 'sub-first', role: 'owner' }),
    ]);
  });

  it('repairs a legacy ownerless org when a super-admin creates it again', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'legacy' });
    await store.createOrgWithOwner({
      slug: 'legacy',
      owner: { subject: 'sub-admin', email: 'admin@example.com' },
    });

    expect(await store.listOrgMembers('legacy')).toEqual([
      expect.objectContaining({ subject: 'sub-admin', role: 'owner' }),
    ]);
  });
});

describe('org invitation listing', () => {
  it('lists every invitation for one org newest-first, including accepted and expired records', async () => {
    const { store, tick } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.createOrgInvitation({
      org: 'acme',
      email: 'First@Example.com',
      role: 'developer',
      tokenHash: 'hash-first',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    tick('2026-07-02T00:00:00.000Z');
    await store.createOrgInvitation({
      org: 'acme',
      email: 'second@example.com',
      role: 'owner',
      tokenHash: 'hash-second',
      createdBySubject: 'sub-owner',
      expiresAt: new Date('2026-07-03T00:00:00.000Z'),
    });
    // Another org's invitation must never leak into acme's listing.
    await store.createOrgInvitation({
      org: 'beta',
      email: 'other@example.com',
      role: 'developer',
      tokenHash: 'hash-other',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    await store.consumeOrgInvitation({ tokenHash: 'hash-first' });

    const invitations = await store.listOrgInvitations('acme');
    expect(invitations.map((record) => record.email)).toEqual([
      'second@example.com',
      'first@example.com',
    ]);
    // Accepted records stay listed (the route derives status); acceptance is visible.
    expect(invitations[1]?.acceptedAt).toBeDefined();
    expect(invitations[0]?.acceptedAt).toBeUndefined();
  });

  it('rejects invalid org slugs', () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    expect(() => store.listOrgInvitations('Not A Slug')).toThrow(/invalid org slug/);
  });
});

describe('org invitation revocation', () => {
  it('revokes unaccepted invitations by email (case-insensitive) and reports the count', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.createOrgInvitation({
      org: 'acme',
      email: 'new@example.com',
      role: 'developer',
      tokenHash: 'hash-a',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    await store.createOrgInvitation({
      org: 'acme',
      email: 'new@example.com',
      role: 'owner',
      tokenHash: 'hash-b',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    expect(await store.revokeOrgInvitation({ org: 'acme', email: 'New@Example.COM' })).toBe(2);
    expect(await store.getOrgInvitation({ tokenHash: 'hash-a' })).toBeUndefined();
    expect(await store.getOrgInvitation({ tokenHash: 'hash-b' })).toBeUndefined();
    expect(await store.listOrgInvitations('acme')).toEqual([]);
  });

  it('leaves accepted invitations in place and scopes revocation to the org', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.createOrgInvitation({
      org: 'acme',
      email: 'joined@example.com',
      role: 'developer',
      tokenHash: 'hash-joined',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    await store.consumeOrgInvitation({ tokenHash: 'hash-joined' });
    await store.createOrgInvitation({
      org: 'beta',
      email: 'joined@example.com',
      role: 'developer',
      tokenHash: 'hash-beta',
      createdBySubject: 'sub-owner',
      expiresAt: FAR_FUTURE,
    });
    // The accepted record is history, and beta's invitation belongs to beta.
    expect(await store.revokeOrgInvitation({ org: 'acme', email: 'joined@example.com' })).toBe(0);
    expect((await store.listOrgInvitations('acme'))[0]?.acceptedAt).toBeDefined();
    expect(await store.getOrgInvitation({ tokenHash: 'hash-beta' })).toBeDefined();
  });
});

describe('OpenAI Apps challenge storage', () => {
  it('sets, trims, updates, and clears one challenge per org', async () => {
    const { store, tick } = storeAt('2026-07-01T00:00:00.000Z');
    const first = await store.setOrgOpenAIAppsChallenge({
      org: 'acme',
      challenge: '  challenge-one  ',
      updatedBySubject: 'owner-sub',
      updatedByEmail: 'owner@example.com',
    });
    expect(first).toMatchObject({
      orgSlug: 'acme',
      challenge: 'challenge-one',
      updatedAt: '2026-07-01T00:00:00.000Z',
      updatedBySubject: 'owner-sub',
      updatedByEmail: 'owner@example.com',
    });

    tick('2026-07-02T00:00:00.000Z');
    await store.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'challenge-two' });
    expect(await store.getOrgOpenAIAppsChallenge('acme')).toMatchObject({
      orgSlug: 'acme',
      challenge: 'challenge-two',
      updatedAt: '2026-07-02T00:00:00.000Z',
    });

    expect(await store.clearOrgOpenAIAppsChallenge('acme')).toBe(true);
    expect(await store.getOrgOpenAIAppsChallenge('acme')).toBeUndefined();
    expect(await store.clearOrgOpenAIAppsChallenge('acme')).toBe(false);
  });

  it('rejects invalid challenge values', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await expect(
      store.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: '   ' }),
    ).rejects.toThrow(/must be a non-empty string/);
    await expect(
      store.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'line-one\nline-two' }),
    ).rejects.toThrow(/must be a single line/);
    await expect(
      store.setOrgOpenAIAppsChallenge({ org: 'acme', challenge: 'x'.repeat(2049) }),
    ).rejects.toThrow(/at most 2048 characters/);
  });
});

describe('org rename', () => {
  it('updates the display name and returns the updated record', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'acme', displayName: 'Acme' });
    const updated = await store.updateOrg({ slug: 'acme', displayName: 'Acme Industries' });
    expect(updated).toMatchObject({ slug: 'acme', displayName: 'Acme Industries' });
    expect((await store.listOrgs())[0]?.displayName).toBe('Acme Industries');
  });

  it('returns undefined for unknown orgs instead of creating one', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    expect(await store.updateOrg({ slug: 'ghost', displayName: 'Ghost' })).toBeUndefined();
    expect(await store.listOrgs()).toEqual([]);
  });
});

describe('member role change', () => {
  it('updates an existing member role and returns the updated record', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.addOrgMember({
      org: 'acme',
      subject: 'sub-dev',
      email: 'dev@example.com',
      role: 'developer',
    });
    const updated = await store.updateOrgMemberRole({
      org: 'acme',
      subject: 'sub-dev',
      role: 'owner',
    });
    expect(updated).toMatchObject({ orgSlug: 'acme', subject: 'sub-dev', role: 'owner' });
    expect((await store.getOrgMember({ org: 'acme', subject: 'sub-dev' }))?.role).toBe('owner');
  });

  it('returns undefined for unknown members and rejects invalid roles', async () => {
    const { store } = storeAt('2026-07-01T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    expect(
      await store.updateOrgMemberRole({ org: 'acme', subject: 'sub-ghost', role: 'owner' }),
    ).toBeUndefined();
    expect(() =>
      store.updateOrgMemberRole({
        org: 'acme',
        subject: 'sub-ghost',
        role: 'admin' as 'owner',
      }),
    ).toThrow(/invalid org role/);
  });
});

describe('org domain storage', () => {
  it('adds domains, normalizes case, and is idempotent', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });

    const first = await store.addOrgDomain({ org: 'acme', domain: 'Acme.COM' });
    const again = await store.addOrgDomain({ org: 'acme', domain: 'acme.com' });

    expect(first).toMatchObject({ orgSlug: 'acme', domain: 'acme.com' });
    expect(again.createdAt).toBe(first.createdAt);
    await expect(store.listOrgDomains('acme')).resolves.toHaveLength(1);
  });

  it('grants data-plane membership without any DNS verification', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.addOrgDomain({ org: 'acme', domain: 'acme.com' });

    const member = { org: 'acme', subject: 'employee-sub', email: 'employee@acme.com' };
    await expect(store.isDataPlaneOrgMember(member)).resolves.toBe(true);
    // Data-plane only: it grants no control-plane standing.
    await expect(store.isOrgMember({ org: 'acme', subject: 'employee-sub' })).resolves.toBe(false);
    await expect(store.listOrgsForSubject('employee-sub')).resolves.toEqual([]);
  });

  it('admits any of several registered domains and rejects the rest', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.addOrgDomain({ org: 'acme', domain: 'abc.com' });
    await store.addOrgDomain({ org: 'acme', domain: 'xyz.com' });

    for (const email of ['a@abc.com', 'b@xyz.com']) {
      await expect(
        store.isDataPlaneOrgMember({ org: 'acme', subject: 'sub', email }),
      ).resolves.toBe(true);
    }
    await expect(
      store.isDataPlaneOrgMember({ org: 'acme', subject: 'sub', email: 'c@other.com' }),
    ).resolves.toBe(false);
  });

  it('scopes domains to the claiming org only', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.createOrg({ slug: 'rival' });
    await store.addOrgDomain({ org: 'rival', domain: 'acme.com' });

    await expect(
      store.isDataPlaneOrgMember({ org: 'acme', subject: 'sub', email: 'e@acme.com' }),
    ).resolves.toBe(false);
  });

  it('removes a domain and reports whether anything was removed', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });
    await store.addOrgDomain({ org: 'acme', domain: 'acme.com' });

    await expect(store.removeOrgDomain({ org: 'acme', domain: 'ACME.com' })).resolves.toBe(true);
    await expect(store.removeOrgDomain({ org: 'acme', domain: 'acme.com' })).resolves.toBe(false);
    await expect(
      store.isDataPlaneOrgMember({ org: 'acme', subject: 'sub', email: 'e@acme.com' }),
    ).resolves.toBe(false);
  });

  it('refuses public email providers and points at the authenticated access mode', async () => {
    const { store } = storeAt('2026-07-24T00:00:00.000Z');
    await store.createOrg({ slug: 'acme' });

    await expect(store.addOrgDomain({ org: 'acme', domain: 'gmail.com' })).rejects.toThrow(
      /--access authenticated/,
    );
    await expect(store.listOrgDomains('acme')).resolves.toEqual([]);
  });
});

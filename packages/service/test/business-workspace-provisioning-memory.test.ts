import {
  InMemoryAtomicState,
  InMemoryControlPlaneStore,
  personalOrgSlug,
} from '@noodle-borg/control-plane/portable';
import { describe, expect, it, vi } from 'vitest';
import { BusinessMemoryLocks } from '../src/business-information/in-memory-locks.js';
import { InMemoryBusinessWorkspaceBackend } from '../src/business-workspaces/memory.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';

function setup() {
  const transactions = new InMemoryAtomicState();
  const backend = new InMemoryBusinessWorkspaceBackend(undefined, undefined, transactions);
  const workspaces = new BusinessWorkspaceStore(backend, { isIdentityActive: async () => true });
  const commercial = transactions.map<string, string>();
  let failure: 'before' | 'after' | undefined;
  const created = vi.fn(async (scope: { org: string; ownerSubject: string }) => {
    commercial.set(scope.org, 'provisioned');
    if (failure === 'before') throw new Error('commercial provisioning failed');
    await workspaces.initializeNewWorkspace(scope);
    if (failure === 'after') throw new Error('owner initialization failed');
  });
  const store = new InMemoryControlPlaneStore({ transactions, personalWorkspaceCreated: created });
  const subject = 'new-owner';
  const email = 'owner@example.test';
  const user = {
    subject,
    email,
    slug: personalOrgSlug({ subject, email }),
    displayName: 'Business',
  };
  return {
    transactions,
    backend,
    workspaces,
    commercial,
    created,
    store,
    user,
    fail: (value: typeof failure) => {
      failure = value;
    },
  };
}

async function expectAbsent(f: ReturnType<typeof setup>) {
  expect(await f.store.getOrg(f.user.slug)).toBeUndefined();
  expect(await f.store.listOrgMembers(f.user.slug)).toEqual([]);
  expect(await f.store.getWelcomeEmail(f.user.subject)).toBeUndefined();
  expect(await f.store.getActiveMcpSubdomain(f.user.slug)).toBeUndefined();
  expect(await f.backend.read(f.user.slug)).toBeUndefined();
  expect(f.commercial.has(f.user.slug)).toBe(false);
}

describe('atomic fresh workspace in the local profile', () => {
  it('does not expose a half-created workspace, billing probe or welcome during setup', async () => {
    const f = setup();
    let entered = () => {};
    let release = () => {};
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    const initialize = f.workspaces.initializeNewWorkspace.bind(f.workspaces);
    vi.spyOn(f.workspaces, 'initializeNewWorkspace').mockImplementation(async (input) => {
      const result = await initialize(input);
      entered();
      await resume;
      return result;
    });
    const pending = f.store.provisionPersonalWorkspace(f.user);
    await waiting;
    await expectAbsent(f);
    release();
    await pending;
    expect((await f.workspaces.inspect(f.user.slug, f.user.subject)).role).toBe('owner');
  });

  it('commits one Owner, organization, routing claim and welcome under concurrent retries', async () => {
    const f = setup();
    const results = await Promise.all([
      f.store.provisionPersonalWorkspace(f.user),
      f.store.provisionPersonalWorkspace(f.user),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(f.created).toHaveBeenCalledTimes(1);
    expect((await f.workspaces.inspect(f.user.slug, f.user.subject)).role).toBe('owner');
    expect(await f.store.getWelcomeEmail(f.user.subject)).toMatchObject({ attemptCount: 0 });
    expect(await f.store.getActiveMcpSubdomain(f.user.slug)).toMatchObject({
      orgSlug: f.user.slug,
    });
    expect(f.commercial.get(f.user.slug)).toBe('provisioned');
  });

  it.each([
    'before',
    'after',
  ] as const)('rolls back a %s-initialization failure and permits a clean retry', async (failure) => {
    const f = setup();
    f.fail(failure);
    await expect(f.store.provisionPersonalWorkspace(f.user)).rejects.toThrow('failed');
    await expectAbsent(f);
    f.fail(undefined);
    expect((await f.store.provisionPersonalWorkspace(f.user)).created).toBe(true);
    expect((await f.workspaces.inspect(f.user.slug, f.user.subject)).revision).toBe(1);
  });

  it('rolls back an outer failure and a caught nested failure', async () => {
    const f = setup();
    await expect(
      f.transactions.run(async () => {
        await f.store.provisionPersonalWorkspace(f.user);
        throw new Error('outer failed');
      }),
    ).rejects.toThrow('outer failed');
    await expectAbsent(f);
    f.fail('after');
    await expect(
      f.transactions.run(async () => {
        await expect(f.store.provisionPersonalWorkspace(f.user)).rejects.toThrow('failed');
      }),
    ).rejects.toThrow('failed');
    await expectAbsent(f);
  });

  it('borrows an outer workspace transaction without losing nested state or audit revisions', async () => {
    const f = setup();
    await f.backend.run(f.user.slug, async (tx) => {
      await f.store.provisionPersonalWorkspace(f.user);
      expect((await tx.get())?.revision).toBe(1);
    });
    expect((await f.workspaces.inspect(f.user.slug, f.user.subject)).revision).toBe(1);
  });

  it('requires an explicit shared transaction context before installing a fresh-only hook', () => {
    expect(
      () => new InMemoryControlPlaneStore({ personalWorkspaceCreated: async () => {} }),
    ).toThrow('shared memory transaction');
    expect(
      () =>
        new InMemoryBusinessWorkspaceBackend(
          new BusinessMemoryLocks(),
          undefined,
          new InMemoryAtomicState(),
        ),
    ).toThrow('not both');
  });

  it('does not initialize discovered legacy ownership or promote it on later binding repair', async () => {
    const f = setup();
    await f.store.createOrgWithOwner({
      slug: f.user.slug,
      owner: { subject: f.user.subject, email: f.user.email },
    });
    expect((await f.store.provisionPersonalWorkspace(f.user)).created).toBe(false);
    expect(
      (await f.store.provisionPersonalWorkspace({ ...f.user, email: 'changed@example.test' }))
        .created,
    ).toBe(false);
    expect(f.created).not.toHaveBeenCalled();
    expect(await f.backend.read(f.user.slug)).toBeUndefined();
  });

  it('preserves an unrelated organization and refuses a competing owner for the same slug', async () => {
    const f = setup();
    await f.store.createOrgWithOwner({
      slug: 'unrelated',
      owner: { subject: 'other', email: 'other@example.test' },
    });
    f.fail('after');
    await expect(f.store.provisionPersonalWorkspace(f.user)).rejects.toThrow('failed');
    expect(await f.store.getOrgMember({ org: 'unrelated', subject: 'other' })).toMatchObject({
      role: 'owner',
    });
    f.fail(undefined);
    await f.store.provisionPersonalWorkspace(f.user);
    await expect(
      f.store.provisionPersonalWorkspace({ ...f.user, subject: 'intruder' }),
    ).rejects.toThrow('already assigned');
    expect((await f.workspaces.inspect(f.user.slug, f.user.subject)).members).toHaveLength(1);
  });
});

import { PlatformIdentityError } from '@noodle-borg/module';
import { expect, it, vi } from 'vitest';
import type {
  BusinessInformationStore,
  InstallationScope,
} from '../src/business-information/contracts.js';

export const pageContent = {
  introduction: 'Independent business',
  sections: [{ title: 'Services', text: 'Ask us about our services.' }],
};
const notice = {
  displayName: 'Acme',
  privacyUrl: 'https://example.com/privacy',
  supportUrl: 'mailto:help@example.com',
};
export function businessPageConformance(create: () => Promise<BusinessInformationStore>) {
  let sequence = 0;
  async function setup() {
    const store = await create();
    const scope: InstallationScope = {
      org: 'page-org',
      app: 'travel',
      env: 'prod',
      installationId: `page-${++sequence}`,
    };
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'owner',
    });
    await store.setBusinessNotice({ scope, notice, expectedRevision: 0, actorSubject: 'owner' });
    const save = (expectedRevision: number, content = pageContent, actorSubject = 'owner') =>
      store.pages.update({
        scope,
        actorSubject,
        change: { operation: 'save', expectedRevision, content },
      });
    const publish = (expectedRevision: number) =>
      store.pages.update(
        { scope, actorSubject: 'owner', change: { operation: 'publish', expectedRevision } },
        async () => ({ deploymentId: 'deployment-one' }),
      );
    return { store, scope, save, publish };
  }
  it('starts private, publishes one exact revision, and keeps later edits private', async () => {
    const { store, scope, save, publish } = await setup();
    expect(await store.pages.get(scope)).toBeUndefined();
    const saved = await save(0);
    expect(saved).toMatchObject({ revision: 1, draft: pageContent, published: null });
    const published = await publish(1);
    expect(published).toMatchObject({
      revision: 2,
      published: {
        content: pageContent,
        notice,
        noticeRevision: 1,
        sourceRevision: 1,
        deploymentId: 'deployment-one',
      },
    });
    const edited = await save(2, { ...pageContent, introduction: 'Private new draft' });
    expect(edited.published).toEqual(published.published);
    expect(edited.draft.introduction).toBe('Private new draft');
    const hidden = await store.pages.update({
      scope,
      actorSubject: 'owner',
      change: { operation: 'unpublish', expectedRevision: 3 },
    });
    expect(hidden).toMatchObject({ revision: 4, published: null, draft: edited.draft });
    expect((await publish(4)).published?.content).toEqual(edited.draft);
    expect((await store.getInstallation(scope))?.publicId).toMatch(/^sol_/);
  });
  it('refuses stale writes atomically, including a stale publish and unpublish', async () => {
    const { store, scope, save, publish } = await setup();
    await save(0);
    const attempts = await Promise.allSettled([save(1), save(1)]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(publish(1)).rejects.toMatchObject({ code: 'business_page_conflict' });
    await publish(2);
    await expect(
      store.pages.update({
        scope,
        actorSubject: 'owner',
        change: { operation: 'unpublish', expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'business_page_conflict' });
    expect((await store.pages.get(scope))?.published).not.toBeNull();
  });
  it('requires active administrator authority and isolates installation scope', async () => {
    const { store, scope, save, publish } = await setup();
    for (const role of ['manager', 'operator', 'viewer'] as const) {
      await store.setGrant({
        scope,
        subject: role,
        email: `${role}@example.com`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
      await expect(save(0, pageContent, role)).rejects.toMatchObject({
        code: 'business_page_forbidden',
      });
    }
    await expect(save(0, pageContent, 'stranger')).rejects.toMatchObject({
      code: 'business_page_forbidden',
    });
    await save(0);
    expect(await store.pages.get({ ...scope, org: 'other-org' })).toBeUndefined();
    expect(await store.pages.get({ ...scope, app: 'other-app' })).toBeUndefined();
    await store.setGrant({
      scope,
      subject: 'second-owner',
      email: 'second@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'owner',
    });
    await store.revokeGrant({
      scope,
      subject: 'owner',
      expectedRevision: 1,
      actorSubject: 'second-owner',
    });
    await expect(publish(1)).rejects.toMatchObject({ code: 'business_page_forbidden' });
    expect((await store.pages.get(scope))?.revision).toBe(1);
  });
  it('fails closed without publication readiness and does not partially change state', async () => {
    const { store, scope, save, publish } = await setup();
    await expect(publish(1)).rejects.toMatchObject({ code: 'business_page_conflict' });
    await save(0);
    const input = {
      scope,
      actorSubject: 'owner',
      change: { operation: 'publish' as const, expectedRevision: 1 },
    };
    await expect(store.pages.update(input)).rejects.toMatchObject({
      code: 'business_page_not_ready',
    });
    await expect(
      store.pages.update(input, async () => {
        throw new Error('runtime unavailable');
      }),
    ).rejects.toThrow();
    expect((await store.pages.get(scope))?.revision).toBe(1);
    expect((await store.pages.get(scope))?.published).toBeNull();
  });
  it('validates internal callers and detaches both stored inputs and returned state', async () => {
    const { store, scope, save } = await setup();
    await expect(save(0, { ...pageContent, introduction: 'x'.repeat(1201) })).rejects.toThrow();
    const content = structuredClone(pageContent);
    const saved = await save(0, content);
    content.sections[0]!.text = 'mutated input';
    saved.draft.sections[0]!.text = 'mutated output';
    expect((await store.pages.get(scope))?.draft).toEqual(pageContent);
  });
  it('rechecks canonical principal suspension and fails closed on identity outage inside mutation', async () => {
    const { store, scope, save } = await setup();
    await save(0);
    let failure: Error = new PlatformIdentityError('principal_suspended');
    const assertActive = async () => {
      throw failure;
    };
    store.configurePrincipalAuthority({
      principalResolver: {
        assertActive,
        resolve: vi.fn(),
        resolveLinked: vi.fn(),
        hasVerifiedEmailEvidence: vi.fn(),
        assertEmailAvailable: vi.fn(),
        resolveExisting: vi.fn(),
        lookupActiveVerifiedEmails: vi.fn(),
      },
      assertActivePrincipal: assertActive,
    });
    try {
      await expect(save(1)).rejects.toMatchObject({ code: 'business_page_forbidden' });
      failure = new Error('identity unavailable');
      await expect(save(1)).rejects.toThrow('identity unavailable');
      expect((await store.pages.get(scope))?.revision).toBe(1);
    } finally {
      store.configurePrincipalAuthority(undefined);
    }
  });
}

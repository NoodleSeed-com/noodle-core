import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { BusinessInformationStore } from '../src/business-information/contracts.js';
import type { BusinessWorkspaceBackend } from '../src/business-workspaces/contracts.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { pageContent } from './business-page-conformance.js';

const notice = {
  displayName: 'Acme',
  privacyUrl: 'https://example.test/privacy',
  supportUrl: 'mailto:help@example.test',
};

export function businessWorkspaceAdminConformance(
  create: () => Promise<{
    business: BusinessInformationStore;
    backend: BusinessWorkspaceBackend;
  }>,
) {
  async function setup() {
    const { business, backend } = await create();
    const suspended = new Set<string>();
    const workspaces = new BusinessWorkspaceStore(backend, {
      isIdentityActive: async (subject) => !suspended.has(subject),
    });
    const scope = {
      org: `admin-${randomUUID()}`,
      app: 'assistant',
      env: 'prod',
      installationId: 'native',
    };
    await business.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      actorSubject: 'legacy-admin',
    });
    await workspaces.initializeNewWorkspace({ org: scope.org, ownerSubject: 'owner' });
    for (const role of ['administrator', 'builder', 'operator', 'viewer'] as const) {
      const invitation = await workspaces.invite({
        org: scope.org,
        actor: 'owner',
        role,
        expectedRevision: (await workspaces.inspect(scope.org, 'owner')).revision,
        email: `${role}@example.test`,
      });
      await workspaces.accept({
        org: scope.org,
        subject: role,
        token: invitation.token,
        verifiedEmail: `${role}@example.test`,
      });
    }
    business.staff.configure(workspaces);
    return { business, scope, workspaces, suspended };
  }

  it('uses workspace administration for business notices and hosted pages without legacy grants', async () => {
    const { business, scope } = await setup();
    for (const actorSubject of [
      'owner',
      'administrator',
      'builder',
      'operator',
      'viewer',
      'legacy-admin',
      'stranger',
    ]) {
      const noticeRevision = (await business.getBusinessNotice(scope))?.revision ?? 0;
      const pageRevision = (await business.pages.get(scope))?.revision ?? 0;
      const saveNotice = () =>
        business.setBusinessNotice({
          scope,
          actorSubject,
          expectedRevision: noticeRevision,
          notice,
        });
      const savePage = () =>
        business.pages.update({
          scope,
          actorSubject,
          change: { operation: 'save', expectedRevision: pageRevision, content: pageContent },
        });
      if (actorSubject === 'owner' || actorSubject === 'administrator') {
        expect((await saveNotice()).revision).toBe(noticeRevision + 1);
        expect((await savePage()).revision).toBe(pageRevision + 1);
      } else {
        await expect(saveNotice()).rejects.toMatchObject({ code: 'business_notice_forbidden' });
        await expect(savePage()).rejects.toMatchObject({ code: 'business_page_forbidden' });
      }
    }
  });

  it('checks current authority for publication, unpublication and suspension without changing saved content', async () => {
    const { business, scope, workspaces, suspended } = await setup();
    await business.setBusinessNotice({ scope, actorSubject: 'owner', expectedRevision: 0, notice });
    await business.pages.update({
      scope,
      actorSubject: 'owner',
      change: { operation: 'save', expectedRevision: 0, content: pageContent },
    });
    const published = await business.pages.update(
      {
        scope,
        actorSubject: 'administrator',
        change: { operation: 'publish', expectedRevision: 1 },
      },
      async () => ({ deploymentId: 'live-one' }),
    );
    expect(published.published?.sourceRevision).toBe(1);
    await workspaces.changeRole({
      org: scope.org,
      actor: 'owner',
      subject: 'administrator',
      role: null,
      expectedRevision: (await workspaces.inspect(scope.org, 'owner')).revision,
    });
    await expect(
      business.pages.update({
        scope,
        actorSubject: 'administrator',
        change: { operation: 'unpublish', expectedRevision: 2 },
      }),
    ).rejects.toMatchObject({ code: 'business_page_forbidden' });
    suspended.add('owner');
    await expect(
      business.setBusinessNotice({ scope, actorSubject: 'owner', expectedRevision: 1, notice }),
    ).rejects.toMatchObject({ code: 'business_notice_forbidden' });
    expect(await business.pages.get(scope)).toEqual(published);
    expect((await business.getBusinessNotice(scope))?.revision).toBe(1);
    suspended.delete('owner');
    const hidden = await business.pages.update({
      scope,
      actorSubject: 'owner',
      change: { operation: 'unpublish', expectedRevision: 2 },
    });
    expect(hidden.published).toBeNull();
  });
}

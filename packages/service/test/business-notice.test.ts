import { describe, expect, it } from 'vitest';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';

describe('installation-owned business notice', () => {
  it('requires live administrator authority, preserves revisions and isolates installations', async () => {
    const store = new InMemoryBusinessInformationStore();
    const scope = { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' };
    const notice = {
      displayName: 'Acme Travel',
      privacyUrl: 'https://acme.example/privacy',
      supportUrl: 'mailto:support@acme.example',
    };
    for (const org of ['acme', 'other'])
      await store.createInstallation({
        scope: { ...scope, org },
        profileKey: 'travel',
        managedCollections: ['travel_requests'],
        actorSubject: `${org}-owner`,
      });
    expect(await store.getBusinessNotice(scope)).toBeUndefined();
    await expect(
      store.setBusinessNotice({ scope, expectedRevision: 0, notice, actorSubject: 'other-owner' }),
    ).rejects.toMatchObject({ code: 'business_notice_forbidden' });
    const value = await store.setBusinessNotice({
      scope,
      expectedRevision: 0,
      notice,
      actorSubject: 'acme-owner',
    });
    expect(value).toMatchObject({ revision: 1, notice });
    expect(await store.getBusinessNotice({ ...scope, org: 'other' })).toBeUndefined();
    await expect(
      store.setBusinessNotice({ scope, expectedRevision: 0, notice, actorSubject: 'acme-owner' }),
    ).rejects.toMatchObject({ code: 'business_notice_conflict' });
    await expect(
      store.setBusinessNotice({
        scope,
        expectedRevision: 1,
        notice: { ...notice, privacyUrl: 'javascript:alert(1)' },
        actorSubject: 'acme-owner',
      }),
    ).rejects.toThrow();
    const results = await Promise.allSettled(
      ['A', 'B'].map((displayName) =>
        store.setBusinessNotice({
          scope,
          expectedRevision: 1,
          notice: { ...notice, displayName },
          actorSubject: 'acme-owner',
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await store.getBusinessNotice(scope)).toMatchObject({ revision: 2 });
    const read = await store.getBusinessNotice(scope);
    if (read) Object.assign(read.notice, { displayName: 'Mutated caller copy' });
    expect((await store.getBusinessNotice(scope))?.notice.displayName).not.toBe(
      'Mutated caller copy',
    );
  });
});

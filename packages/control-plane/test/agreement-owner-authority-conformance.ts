import { expect, it } from 'vitest';
import type {
  OrganizationAgreementOwnerAuthority,
  OrganizationAgreementStore,
} from '../src/organization-agreements.js';

/** The host-policy port has the same no-fallback and receipt semantics in both adapters. */
export function agreementOwnerAuthorityConformance(
  fixture: () => Promise<{
    store: OrganizationAgreementStore;
    org: string;
    legacyOwner: string;
  }>,
) {
  const documents = {
    version: 'selected-owner-contract',
    terms: { url: 'https://example.test/terms', sha256: 'a'.repeat(64) },
    privacy: { url: 'https://example.test/privacy', sha256: 'b'.repeat(64) },
    processing: { url: 'https://example.test/processing', sha256: 'c'.repeat(64) },
  };
  it('selects host ownership without a legacy grant and reauthorizes an equal receipt', async () => {
    const { store, org } = await fixture();
    let allowed = true;
    const authority: OrganizationAgreementOwnerAuthority = {
      run: async (selectedOrg, actor, commit) => {
        expect(selectedOrg).toBe(org);
        expect(actor).toBe('workspace-owner');
        if (!allowed) throw new Error('current owner denied');
        return commit();
      },
    };
    const input = { org, actorSubject: 'workspace-owner', documents };
    const first = await store.acceptOrganizationAgreement(input, authority);
    expect(await store.acceptOrganizationAgreement(input, authority)).toEqual(first);
    allowed = false;
    await expect(store.acceptOrganizationAgreement(input, authority)).rejects.toThrow(
      'current owner denied',
    );
    expect(await store.getOrganizationAgreement(org, documents.version)).toEqual(first);
  });
  it('uses legacy ownership only when explicitly selected, never following a policy outage', async () => {
    const { store, org, legacyOwner } = await fixture();
    const input = { org, actorSubject: legacyOwner, documents };
    await expect(
      store.acceptOrganizationAgreement(input, {
        run: async () => {
          throw new Error('authority unavailable');
        },
      }),
    ).rejects.toThrow('authority unavailable');
    expect(await store.getOrganizationAgreement(org, documents.version)).toBeUndefined();
    const legacy: OrganizationAgreementOwnerAuthority = {
      run: (_org, _actor, _commit, retained) => retained(),
    };
    expect(await store.acceptOrganizationAgreement(input, legacy)).toMatchObject({
      actorSubject: legacyOwner,
    });
    await expect(
      store.acceptOrganizationAgreement({ ...input, actorSubject: 'stranger' }, legacy),
    ).rejects.toMatchObject({ code: 'agreement_owner_required' });
  });
}

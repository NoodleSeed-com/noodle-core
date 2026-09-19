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

  it('rolls back both catalog registration and receipt if authority fails after the write', async () => {
    const { store, org } = await fixture();
    const selected = { ...documents, version: 'owner-authority-rollback' };
    const input = { org, actorSubject: 'workspace-owner', documents: selected };
    await expect(
      store.acceptOrganizationAgreement(input, {
        run: async (_org, _actor, commit) => {
          await commit();
          throw new Error('authority completion failed');
        },
      }),
    ).rejects.toThrow('authority completion failed');
    expect(await store.getOrganizationAgreement(org, selected.version)).toBeUndefined();
    const corrected = { ...selected, terms: { ...selected.terms, sha256: 'd'.repeat(64) } };
    const receipt = await store.acceptOrganizationAgreement(
      { ...input, documents: corrected },
      { run: (_org, _actor, commit) => commit() },
    );
    expect(receipt.documents).toEqual(corrected);
    await expect(
      store.acceptOrganizationAgreement(
        { ...input, documents: corrected },
        {
          run: async (_org, _actor, commit) => {
            await commit();
            throw new Error('replay failed');
          },
        },
      ),
    ).rejects.toThrow('replay failed');
    expect(await store.getOrganizationAgreement(org, selected.version)).toEqual(receipt);
  });

  it('keeps a pending acceptance private until its authority operation completes', async () => {
    const { store, org } = await fixture();
    let entered = () => {};
    const committed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const selected = { ...documents, version: 'owner-authority-private' };
    const acceptance = store.acceptOrganizationAgreement(
      { org, actorSubject: 'workspace-owner', documents: selected },
      {
        run: async (_org, _actor, commit) => {
          await commit();
          entered();
          await held;
          throw new Error('authority completion failed');
        },
      },
    );
    const failure = expect(acceptance).rejects.toThrow('authority completion failed');
    await committed;
    try {
      expect(await store.getOrganizationAgreement(org, selected.version)).toBeUndefined();
    } finally {
      release();
      await failure;
    }
    expect(await store.getOrganizationAgreement(org, selected.version)).toBeUndefined();
  });
}

import { describe, expect, it } from 'vitest';
import { InMemoryControlPlaneStore } from '../src/in-memory-control-plane-store.js';
import {
  agreementDocumentDigest,
  validateAgreementDocuments,
} from '../src/organization-agreements.js';

const documents = {
  version: 'beta-2026-09',
  terms: { url: 'https://example.com/terms/beta-2026-09', sha256: 'a'.repeat(64) },
  privacy: { url: 'https://example.com/privacy/beta-2026-09', sha256: 'b'.repeat(64) },
  processing: { url: 'https://example.com/processing/beta-2026-09', sha256: 'c'.repeat(64) },
};

async function setup() {
  const store = new InMemoryControlPlaneStore({ now: () => new Date('2026-09-07T12:00:00Z') });
  for (const org of ['first', 'second']) {
    await store.createOrgWithOwner({
      slug: org,
      owner: { subject: `${org}-owner`, email: `${org}@example.com` },
    });
    await store.addOrgMember({
      org,
      subject: 'developer',
      email: 'developer@example.com',
      role: 'developer',
    });
  }
  return store;
}

describe('organization agreement acceptance', () => {
  it('records exact documents and server time once, isolated by organization', async () => {
    const store = await setup();
    expect(await store.getOrganizationAgreement('first', documents.version)).toBeUndefined();
    const input = { org: 'first', actorSubject: 'first-owner', documents };
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => store.acceptOrganizationAgreement(input)),
    );
    for (const receipt of receipts)
      expect(receipt).toEqual({
        org: 'first',
        actorSubject: 'first-owner',
        documents,
        documentDigest: agreementDocumentDigest(documents),
        acceptedAt: '2026-09-07T12:00:00.000Z',
      });
    expect(await store.getOrganizationAgreement('second', documents.version)).toBeUndefined();
    expect(Object.keys(receipts[0] ?? {}).sort()).toEqual([
      'acceptedAt',
      'actorSubject',
      'documentDigest',
      'documents',
      'org',
    ]);
  });

  it('requires current exact organization ownership even for a replay', async () => {
    const store = await setup();
    for (const actorSubject of ['developer', 'second-owner', 'unknown']) {
      await expect(
        store.acceptOrganizationAgreement({ org: 'first', actorSubject, documents }),
      ).rejects.toMatchObject({ code: 'agreement_owner_required' });
    }
    await store.acceptOrganizationAgreement({
      org: 'first',
      actorSubject: 'first-owner',
      documents,
    });
    await store.removeOrgMember({ org: 'first', subject: 'first-owner' });
    await expect(
      store.acceptOrganizationAgreement({ org: 'first', actorSubject: 'first-owner', documents }),
    ).rejects.toMatchObject({ code: 'agreement_owner_required' });
    expect(await store.getOrganizationAgreement('first', documents.version)).toMatchObject({
      actorSubject: 'first-owner',
    });
  });

  it('never replaces a registered version or a historical receipt', async () => {
    const store = await setup();
    const first = await store.acceptOrganizationAgreement({
      org: 'first',
      actorSubject: 'first-owner',
      documents,
    });
    const changed = { ...documents, terms: { ...documents.terms, sha256: 'd'.repeat(64) } };
    for (const org of ['first', 'second']) {
      await expect(
        store.acceptOrganizationAgreement({
          org,
          actorSubject: `${org}-owner`,
          documents: changed,
        }),
      ).rejects.toMatchObject({ code: 'agreement_version_conflict' });
    }
    const next = { ...changed, version: 'beta-2026-10' };
    await store.acceptOrganizationAgreement({
      org: 'first',
      actorSubject: 'first-owner',
      documents: next,
    });
    expect(await store.getOrganizationAgreement('first', documents.version)).toEqual(first);
    expect(await store.getOrganizationAgreement('first', next.version)).toMatchObject({
      documents: next,
    });
    const returned = await store.getOrganizationAgreement('first', documents.version);
    if (returned) Object.assign(returned.documents.terms, { url: 'https://attacker.example' });
    expect(await store.getOrganizationAgreement('first', documents.version)).toEqual(first);
  });

  it('validates only bounded immutable HTTPS document identities', () => {
    for (const url of [
      'http://example.com/terms',
      'javascript:alert(1)',
      'https://user:pass@example.com',
      'https://example.com/#fragment',
    ]) {
      expect(() =>
        validateAgreementDocuments({ ...documents, terms: { ...documents.terms, url } }),
      ).toThrow();
    }
    for (const version of ['', 'a'.repeat(81), '../terms'])
      expect(() => validateAgreementDocuments({ ...documents, version })).toThrow();
    expect(() =>
      validateAgreementDocuments({
        ...documents,
        terms: { ...documents.terms, sha256: 'unapproved' },
      }),
    ).toThrow();
    expect(agreementDocumentDigest(documents)).toBe(
      agreementDocumentDigest({
        privacy: documents.privacy,
        processing: documents.processing,
        terms: documents.terms,
        version: documents.version,
      }),
    );
  });
});

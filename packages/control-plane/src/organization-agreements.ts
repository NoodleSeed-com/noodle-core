import { createHash } from 'node:crypto';
import { validateSlug } from './validation.js';

export interface AgreementDocument {
  readonly url: string;
  readonly sha256: string;
}

/** Deployment-approved immutable identities, never supplied authoritatively by a browser. */
export interface AgreementDocuments {
  readonly version: string;
  readonly terms: AgreementDocument;
  readonly privacy: AgreementDocument;
  readonly processing: AgreementDocument;
}

export interface OrganizationAgreementAcceptance {
  readonly org: string;
  readonly actorSubject: string;
  readonly documents: AgreementDocuments;
  readonly documentDigest: string;
  readonly acceptedAt: string;
}

export interface AcceptOrganizationAgreementInput {
  readonly org: string;
  readonly actorSubject: string;
  /** Trusted catalog entry selected by service policy after checking the submitted version/digest. */
  readonly documents: AgreementDocuments;
}

export interface OrganizationAgreementStore {
  getOrganizationAgreement(
    org: string,
    version: string,
  ): Promise<OrganizationAgreementAcceptance | undefined>;
  /** Repeats live exact-owner authorization atomically; equal acceptance preserves the first receipt. */
  acceptOrganizationAgreement(
    input: AcceptOrganizationAgreementInput,
  ): Promise<OrganizationAgreementAcceptance>;
}

export class OrganizationAgreementError extends Error {
  constructor(readonly code: 'agreement_owner_required' | 'agreement_version_conflict') {
    super(
      code === 'agreement_owner_required'
        ? 'Organization owner required to accept agreements.'
        : 'Agreement version has a different immutable document identity.',
    );
    this.name = 'OrganizationAgreementError';
  }
}

export function validateAgreementDocuments(input: AgreementDocuments): AgreementDocuments {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.version))
    throw new Error('Invalid agreement version');
  const document = (value: AgreementDocument): AgreementDocument => {
    if (
      typeof value.url !== 'string' ||
      value.url.length > 2048 ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new Error('Invalid agreement document');
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Invalid agreement document URL');
    return { url: value.url, sha256: value.sha256 };
  };
  return {
    version: input.version,
    terms: document(input.terms),
    privacy: document(input.privacy),
    processing: document(input.processing),
  };
}

export function agreementDocumentDigest(documents: AgreementDocuments): string {
  return createHash('sha256')
    .update(JSON.stringify(validateAgreementDocuments(documents)))
    .digest('hex');
}

/** Synchronous commit boundary keeps membership recheck, catalog registration and receipt indivisible. */
export class InMemoryOrganizationAgreements implements OrganizationAgreementStore {
  readonly #catalog = new Map<string, string>();
  readonly #receipts = new Map<string, OrganizationAgreementAcceptance>();
  constructor(
    private readonly isOwner: (org: string, subject: string) => boolean,
    private readonly now: () => Date,
  ) {}

  getOrganizationAgreement(
    org: string,
    version: string,
  ): Promise<OrganizationAgreementAcceptance | undefined> {
    const receipt = this.#receipts.get(JSON.stringify([validateSlug('org', org), version]));
    return Promise.resolve(receipt ? structuredClone(receipt) : undefined);
  }

  async acceptOrganizationAgreement(
    input: AcceptOrganizationAgreementInput,
  ): Promise<OrganizationAgreementAcceptance> {
    const org = validateSlug('org', input.org);
    if (!this.isOwner(org, input.actorSubject))
      throw new OrganizationAgreementError('agreement_owner_required');
    const documents = validateAgreementDocuments(input.documents);
    const documentDigest = agreementDocumentDigest(documents);
    const registered = this.#catalog.get(documents.version);
    if (registered !== undefined && registered !== documentDigest)
      throw new OrganizationAgreementError('agreement_version_conflict');
    const key = JSON.stringify([org, documents.version]);
    const receipt = this.#receipts.get(key) ?? {
      org,
      actorSubject: input.actorSubject,
      documents,
      documentDigest,
      acceptedAt: this.now().toISOString(),
    };
    this.#catalog.set(documents.version, documentDigest);
    this.#receipts.set(key, receipt);
    return structuredClone(receipt);
  }
}

import {
  type AgreementDocuments,
  agreementDocumentDigest,
  OrganizationAgreementError,
  type OrganizationStore,
  validateAgreementDocuments,
} from '@noodle-borg/control-plane/portable';
import {
  AgreementDocumentsSchema,
  type OrganizationAgreementStatus,
} from '@noodle-borg/wire-contracts';
import type {
  BusinessInformationStore,
  SolutionInstallation,
} from './business-information/contracts.js';

export interface BusinessOnboardingOptions {
  /** Only deployment-approved exact document identities. Empty policy keeps hosted activation closed. */
  readonly documents?: AgreementDocuments;
}
export const BUSINESS_SETUP_MESSAGE =
  'Complete the organization agreement and business notice in Portal before activating this application. Retained records remain accessible.';
export class BusinessSetupError extends Error {
  readonly code = 'business_setup_required';
  constructor() {
    super(BUSINESS_SETUP_MESSAGE);
  }
}

/** Portable hosts may inject their own approved catalog; Noodle-hosted composition always installs this policy. */
export function parseBusinessOnboarding(serialized: string | undefined): BusinessOnboardingOptions {
  if (serialized === undefined) return {};
  if (serialized.length > 16384) throw new Error('Organization agreement catalog is too large');
  return { documents: AgreementDocumentsSchema.parse(JSON.parse(serialized)) };
}

export class BusinessOnboarding {
  readonly #documents: AgreementDocuments | undefined;
  constructor(
    options: BusinessOnboardingOptions,
    private readonly organizations: OrganizationStore,
    private readonly installations: BusinessInformationStore,
  ) {
    this.#documents = options.documents ? validateAgreementDocuments(options.documents) : undefined;
  }

  async status(org: string, subject: string): Promise<OrganizationAgreementStatus> {
    const canAccept = (await this.organizations.getOrgMember({ org, subject }))?.role === 'owner';
    const documents = this.#documents;
    if (!documents) return { canAccept, accepted: false, required: null };
    const documentDigest = agreementDocumentDigest(documents);
    const acceptance = await this.organizations.getOrganizationAgreement(org, documents.version);
    const accepted = acceptance?.documentDigest === documentDigest;
    return {
      canAccept,
      accepted,
      required: { ...structuredClone(documents), documentDigest },
      ...(acceptance
        ? {
            receipt: {
              version: acceptance.documents.version,
              documentDigest: acceptance.documentDigest,
              acceptedAt: acceptance.acceptedAt,
            },
          }
        : {}),
    };
  }

  async accept(
    org: string,
    subject: string,
    input: { version: string; documentDigest: string },
  ): Promise<OrganizationAgreementStatus> {
    const status = await this.status(org, subject);
    if (!status.canAccept) throw new OrganizationAgreementError('agreement_owner_required');
    if (
      !status.required ||
      status.required.version !== input.version ||
      status.required.documentDigest !== input.documentDigest
    )
      throw new OrganizationAgreementError('agreement_version_conflict');
    const documents = this.#documents;
    if (!documents) throw new BusinessSetupError();
    await this.organizations.acceptOrganizationAgreement({ org, actorSubject: subject, documents });
    return this.status(org, subject);
  }

  async ready(installation: SolutionInstallation): Promise<boolean> {
    const documents = this.#documents;
    if (!documents) return false;
    const receipt = await this.organizations.getOrganizationAgreement(
      installation.scope.org,
      documents.version,
    );
    return (
      receipt?.documentDigest === agreementDocumentDigest(documents) &&
      (await this.installations.getBusinessNotice(installation.scope)) !== undefined
    );
  }
}

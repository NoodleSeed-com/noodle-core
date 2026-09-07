import type { Pool } from 'pg';
import type { BusinessNoticeInput } from './business-notice.js';
import type {
  BusinessGrantStore,
  BusinessInformationStore,
  ManagedRequestStore,
  PayloadCipher,
  SolutionInstallationStore,
} from './contracts.js';
import { getBusinessNoticeRow, setBusinessNoticeRow } from './postgres-business-notice.js';
import {
  PostgresInstallationStore,
  type PostgresInstallationStoreOptions,
} from './postgres-installations.js';
import { PostgresBusinessInvitations } from './postgres-invitations.js';
import {
  PostgresManagedRequestStore,
  type PostgresManagedRequestStoreOptions,
} from './postgres-requests.js';
import { ensureBusinessInformationSchema } from './postgres-schema.js';
import {
  BusinessPrincipalAuthority,
  type BusinessPrincipalProvider,
} from './principal-authority.js';

export interface PostgresBusinessInformationStoreOptions
  extends PostgresInstallationStoreOptions,
    PostgresManagedRequestStoreOptions {}

/** Hosted authoritative adapter. Construction fails closed unless a payload cipher is supplied. */
export class PostgresBusinessInformationStore implements BusinessInformationStore {
  readonly #principals = new BusinessPrincipalAuthority();
  readonly #pool: Pool;
  readonly #installations: PostgresInstallationStore;
  readonly #invitations: PostgresBusinessInvitations;
  readonly #requests: PostgresManagedRequestStore;

  constructor(
    pool: Pool,
    cipher: PayloadCipher,
    options: PostgresBusinessInformationStoreOptions = {},
  ) {
    if (
      cipher === undefined ||
      typeof cipher.seal !== 'function' ||
      typeof cipher.open !== 'function'
    ) {
      throw new Error('Postgres business information persistence requires a payload cipher');
    }
    this.#pool = pool;
    this.#installations = new PostgresInstallationStore(pool, options);
    this.#invitations = new PostgresBusinessInvitations(pool, options);
    this.#requests = new PostgresManagedRequestStore(
      pool,
      cipher,
      this.#installations,
      options,
      this.#principals,
    );
  }

  configurePrincipalAuthority(provider: BusinessPrincipalProvider | undefined): void {
    this.#principals.configure(provider);
  }

  async listEligibleAssignees(scope: Parameters<BusinessGrantStore['listGrants']>[0]) {
    return this.#principals.eligible(await this.listGrants(scope));
  }

  ensureSchema(): Promise<void> {
    return ensureBusinessInformationSchema(this.#pool);
  }

  getBusinessNotice(scope: Parameters<BusinessInformationStore['getBusinessNotice']>[0]) {
    return getBusinessNoticeRow(this.#pool, scope);
  }
  setBusinessNotice(input: BusinessNoticeInput) {
    return setBusinessNoticeRow(this.#pool, input);
  }

  bindApplication(
    scope: Parameters<SolutionInstallationStore['bindApplication']>[0],
    generation: string,
  ) {
    return this.#installations.bindApplication(scope, generation);
  }
  pauseApplication(org: string, app: string, at: string, retired = false) {
    return this.#installations.pauseApplication(org, app, at, retired);
  }

  createInstallation(
    input: Parameters<SolutionInstallationStore['createInstallation']>[0],
  ): ReturnType<SolutionInstallationStore['createInstallation']> {
    return this.#installations.createInstallation(input);
  }

  getInstallation(
    scope: Parameters<SolutionInstallationStore['getInstallation']>[0],
  ): ReturnType<SolutionInstallationStore['getInstallation']> {
    return this.#installations.getInstallation(scope);
  }

  getInstallationById(
    org: string,
    installationId: string,
  ): ReturnType<SolutionInstallationStore['getInstallationById']> {
    return this.#installations.getInstallationById(org, installationId);
  }

  resolveInstallationByPublicId(
    publicId: string,
  ): ReturnType<SolutionInstallationStore['resolveInstallationByPublicId']> {
    return this.#installations.resolveInstallationByPublicId(publicId);
  }

  listInstallations(org: string): ReturnType<SolutionInstallationStore['listInstallations']> {
    return this.#installations.listInstallations(org);
  }

  listInstallationsForSubject(
    subject: string,
  ): ReturnType<SolutionInstallationStore['listInstallationsForSubject']> {
    return this.#installations.listInstallationsForSubject(subject);
  }

  setIntakeState(
    input: Parameters<SolutionInstallationStore['setIntakeState']>[0],
  ): ReturnType<SolutionInstallationStore['setIntakeState']> {
    return this.#installations.setIntakeState(input);
  }

  getGrant(
    scope: Parameters<BusinessGrantStore['getGrant']>[0],
    subject: string,
  ): ReturnType<BusinessGrantStore['getGrant']> {
    return this.#installations.getGrant(scope, subject);
  }

  listGrants(
    scope: Parameters<BusinessGrantStore['listGrants']>[0],
  ): ReturnType<BusinessGrantStore['listGrants']> {
    return this.#installations.listGrants(scope);
  }

  setGrant(
    input: Parameters<BusinessGrantStore['setGrant']>[0],
  ): ReturnType<BusinessGrantStore['setGrant']> {
    return this.#installations.setGrant(input);
  }

  revokeGrant(
    input: Parameters<BusinessGrantStore['revokeGrant']>[0],
  ): ReturnType<BusinessGrantStore['revokeGrant']> {
    return this.#installations.revokeGrant(input);
  }

  createInvitation(
    input: Parameters<BusinessGrantStore['createInvitation']>[0],
  ): ReturnType<BusinessGrantStore['createInvitation']> {
    return this.#invitations.create(input);
  }

  listInvitations(
    scope: Parameters<BusinessGrantStore['listInvitations']>[0],
  ): ReturnType<BusinessGrantStore['listInvitations']> {
    return this.#invitations.list(scope);
  }

  revokeInvitation(
    input: Parameters<BusinessGrantStore['revokeInvitation']>[0],
  ): ReturnType<BusinessGrantStore['revokeInvitation']> {
    return this.#invitations.revoke(input);
  }

  claimInvitation(
    input: Parameters<BusinessGrantStore['claimInvitation']>[0],
  ): ReturnType<BusinessGrantStore['claimInvitation']> {
    return this.#invitations.claim(input);
  }

  createRequest(
    input: Parameters<ManagedRequestStore['createRequest']>[0],
  ): ReturnType<ManagedRequestStore['createRequest']> {
    return this.#requests.createRequest(input);
  }

  probeRequest(
    input: Parameters<ManagedRequestStore['probeRequest']>[0],
  ): ReturnType<ManagedRequestStore['probeRequest']> {
    return this.#requests.probeRequest(input);
  }

  getRequest(
    ...input: Parameters<ManagedRequestStore['getRequest']>
  ): ReturnType<ManagedRequestStore['getRequest']> {
    return this.#requests.getRequest(...input);
  }

  listRequests(
    input: Parameters<ManagedRequestStore['listRequests']>[0],
  ): ReturnType<ManagedRequestStore['listRequests']> {
    return this.#requests.listRequests(input);
  }

  mutateRequest(
    input: Parameters<ManagedRequestStore['mutateRequest']>[0],
  ): ReturnType<ManagedRequestStore['mutateRequest']> {
    return this.#requests.mutateRequest(input);
  }

  migrateLegacyRequest(
    input: Parameters<ManagedRequestStore['migrateLegacyRequest']>[0],
  ): ReturnType<ManagedRequestStore['migrateLegacyRequest']> {
    return this.#requests.migrateLegacyRequest(input);
  }

  deleteRequest(
    input: Parameters<ManagedRequestStore['deleteRequest']>[0],
  ): ReturnType<ManagedRequestStore['deleteRequest']> {
    return this.#requests.deleteRequest(input);
  }

  listActivity(
    ...input: Parameters<ManagedRequestStore['listActivity']>
  ): ReturnType<ManagedRequestStore['listActivity']> {
    return this.#requests.listActivity(...input);
  }

  exportRequests(
    input: Parameters<ManagedRequestStore['exportRequests']>[0],
  ): ReturnType<ManagedRequestStore['exportRequests']> {
    return this.#requests.exportRequests(input);
  }

  purgeExpired(
    input: Parameters<ManagedRequestStore['purgeExpired']>[0],
  ): ReturnType<ManagedRequestStore['purgeExpired']> {
    return this.#requests.purgeExpired(input);
  }

  listAcceptedSchemaInventory(): ReturnType<ManagedRequestStore['listAcceptedSchemaInventory']> {
    return this.#requests.listAcceptedSchemaInventory();
  }
}

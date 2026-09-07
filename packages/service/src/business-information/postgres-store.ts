import type { Pool } from 'pg';
import type {
  BusinessGrantStore,
  BusinessInformationStore,
  ManagedRequestStore,
  PayloadCipher,
  SolutionInstallationStore,
} from './contracts.js';
import {
  PostgresInstallationStore,
  type PostgresInstallationStoreOptions,
} from './postgres-installations.js';
import {
  PostgresManagedRequestStore,
  type PostgresManagedRequestStoreOptions,
} from './postgres-requests.js';
import { ensureBusinessInformationSchema } from './postgres-schema.js';

export interface PostgresBusinessInformationStoreOptions
  extends PostgresInstallationStoreOptions,
    PostgresManagedRequestStoreOptions {}

/** Hosted authoritative adapter. Construction fails closed unless a payload cipher is supplied. */
export class PostgresBusinessInformationStore implements BusinessInformationStore {
  readonly #pool: Pool;
  readonly #installations: PostgresInstallationStore;
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
    this.#requests = new PostgresManagedRequestStore(pool, cipher, this.#installations, options);
  }

  ensureSchema(): Promise<void> {
    return ensureBusinessInformationSchema(this.#pool);
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

  createRequest(
    input: Parameters<ManagedRequestStore['createRequest']>[0],
  ): ReturnType<ManagedRequestStore['createRequest']> {
    return this.#requests.createRequest(input);
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
}

import { randomBytes } from 'node:crypto';
import type {
  GoogleWorkloadIdentityRecord,
  GoogleWorkloadIdentityResolver,
} from './google-workload-identity.js';
import { hasAsciiControlCharacters } from './google-workload-identity-validation.js';
import { type TenantRef, validateTenantRef } from './store.js';

export interface StoredGoogleWorkloadIdentity extends GoogleWorkloadIdentityRecord {
  readonly org: string;
  readonly app: string;
  readonly env: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBySubject: string;
  readonly createdByEmail?: string;
  readonly revokedAt?: string;
  readonly revokedBySubject?: string;
  readonly revokedByEmail?: string;
}

export interface PrepareGoogleWorkloadIdentityInput extends TenantRef {
  readonly actorSubject: string;
  readonly actorEmail?: string;
}

export interface RevokeGoogleWorkloadIdentityInput extends TenantRef {
  readonly actorSubject: string;
  readonly actorEmail?: string;
}

export interface GoogleWorkloadIdentityStore extends GoogleWorkloadIdentityResolver {
  prepare(input: PrepareGoogleWorkloadIdentityInput): Promise<StoredGoogleWorkloadIdentity>;
  get(tenant: TenantRef): Promise<StoredGoogleWorkloadIdentity | undefined>;
  revoke(
    input: RevokeGoogleWorkloadIdentityInput,
  ): Promise<StoredGoogleWorkloadIdentity | undefined>;
}

/**
 * Local/test store. Hosted multi-instance services select the PostgreSQL implementation so revocation
 * is visible to every broker before any cached access token is reused.
 */
export class InMemoryGoogleWorkloadIdentityStore implements GoogleWorkloadIdentityStore {
  readonly #records = new Map<string, StoredGoogleWorkloadIdentity>();
  readonly #now: () => Date;
  readonly #randomId: () => string;

  constructor(
    options: {
      readonly now?: () => Date;
      readonly randomId?: () => string;
    } = {},
  ) {
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? (() => `gwi_${randomBytes(18).toString('base64url')}`);
  }

  prepare(input: PrepareGoogleWorkloadIdentityInput): Promise<StoredGoogleWorkloadIdentity> {
    const tenant = validateLifecycleInput(input);
    const key = tenantKey(tenant);
    const existing = this.#records.get(key);
    if (existing?.active) return Promise.resolve(structuredClone(existing));
    const now = this.#now().toISOString();
    const id = validateOpaqueId(this.#randomId());
    const record: StoredGoogleWorkloadIdentity = {
      id,
      revision: id,
      tenantId: key,
      environmentId: tenant.env,
      subject: `noodle:google-workload:${id}`,
      active: true,
      ...tenant,
      createdAt: now,
      updatedAt: now,
      createdBySubject: validateActor(input.actorSubject),
      ...(input.actorEmail === undefined ? {} : { createdByEmail: input.actorEmail }),
    };
    this.#records.set(key, record);
    return Promise.resolve(structuredClone(record));
  }

  get(tenant: TenantRef): Promise<StoredGoogleWorkloadIdentity | undefined> {
    const record = this.#records.get(tenantKey(validateTenantRef(tenant)));
    return Promise.resolve(record === undefined ? undefined : structuredClone(record));
  }

  revoke(
    input: RevokeGoogleWorkloadIdentityInput,
  ): Promise<StoredGoogleWorkloadIdentity | undefined> {
    const tenant = validateLifecycleInput(input);
    const key = tenantKey(tenant);
    const existing = this.#records.get(key);
    if (existing === undefined || !existing.active) {
      return Promise.resolve(existing === undefined ? undefined : structuredClone(existing));
    }
    const now = this.#now().toISOString();
    const revoked: StoredGoogleWorkloadIdentity = {
      ...existing,
      revision: `${existing.id}:revoked`,
      active: false,
      updatedAt: now,
      revokedAt: now,
      revokedBySubject: validateActor(input.actorSubject),
      ...(input.actorEmail === undefined ? {} : { revokedByEmail: input.actorEmail }),
    };
    this.#records.set(key, revoked);
    return Promise.resolve(structuredClone(revoked));
  }

  async resolve(input: {
    readonly tenantId: string;
    readonly deploymentId: string;
  }): Promise<GoogleWorkloadIdentityRecord | undefined> {
    const record = this.#records.get(input.tenantId);
    return record === undefined ? undefined : structuredClone(record);
  }
}

function validateLifecycleInput<T extends TenantRef & { readonly actorSubject: string }>(
  input: T,
): TenantRef {
  validateActor(input.actorSubject);
  return validateTenantRef(input);
}

function validateActor(value: string): string {
  if (value.length < 1 || value.length > 512 || hasAsciiControlCharacters(value)) {
    throw new Error('invalid workload identity actor');
  }
  return value;
}

function validateOpaqueId(value: string): string {
  if (!/^[A-Za-z0-9_-]{4,96}$/.test(value)) {
    throw new Error('invalid workload identity id');
  }
  return value;
}

function tenantKey(tenant: TenantRef): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}`;
}

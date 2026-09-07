import { randomUUID } from 'node:crypto';
import { validateSlug } from '../store/validate.js';
import {
  type ServicePrincipalSigningAlgorithm,
  validatePublicJwk,
} from './service-principal-credentials.js';

export type ServicePrincipalStatus = 'active' | 'revoked';
export type ServicePrincipalCredentialKind = 'public_jwk' | 'client_secret';

export interface ServicePrincipalRecord {
  readonly principalId: string;
  readonly org: string;
  readonly name: string;
  readonly status: ServicePrincipalStatus;
  readonly createdBySubject: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
  readonly revokedBySubject?: string;
}

export interface ServicePrincipalGrantRecord {
  readonly grantId: string;
  readonly principalId: string;
  readonly org: string;
  readonly app: string;
  readonly environment: string;
  readonly scopes: readonly string[];
  readonly status: ServicePrincipalStatus;
  readonly createdBySubject: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revokedAt?: string;
  readonly revokedBySubject?: string;
}

interface ServicePrincipalCredentialBase {
  readonly credentialId: string;
  readonly principalId: string;
  readonly kind: ServicePrincipalCredentialKind;
  readonly label: string;
  readonly status: ServicePrincipalStatus;
  readonly createdBySubject: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  readonly revokedBySubject?: string;
}

export type ServicePrincipalCredentialRecord =
  | (ServicePrincipalCredentialBase & { readonly kind: 'client_secret' })
  | (ServicePrincipalCredentialBase & {
      readonly kind: 'public_jwk';
      readonly algorithm: ServicePrincipalSigningAlgorithm;
      readonly kid?: string;
    });

export interface ServicePrincipalView {
  readonly principal: ServicePrincipalRecord;
  readonly grants: readonly ServicePrincipalGrantRecord[];
  readonly credentials: readonly ServicePrincipalCredentialRecord[];
}

export type ActiveServicePrincipalCredential =
  | (ServicePrincipalCredentialRecord & {
      readonly kind: 'client_secret';
      readonly secretDigest: string;
    })
  | (ServicePrincipalCredentialRecord & {
      readonly kind: 'public_jwk';
      readonly algorithm: ServicePrincipalSigningAlgorithm;
      readonly publicJwk: Readonly<Record<string, unknown>>;
    });

export interface ActiveServicePrincipalClient {
  readonly principal: ServicePrincipalRecord;
  readonly grants: readonly ServicePrincipalGrantRecord[];
  readonly credentials: readonly ActiveServicePrincipalCredential[];
}

export interface CreateServicePrincipalInput {
  readonly org: string;
  readonly name: string;
  readonly actorSubject: string;
}

export interface PrincipalRef {
  readonly principalId: string;
  readonly org: string;
}

export interface PrincipalMutation extends PrincipalRef {
  readonly actorSubject: string;
}

export interface CreateServicePrincipalGrantInput extends PrincipalMutation {
  readonly app: string;
  readonly environment: string;
  readonly scopes: readonly string[];
}

export interface GrantMutation extends PrincipalMutation {
  readonly grantId: string;
}

interface CreateCredentialBase extends PrincipalMutation {
  readonly label: string;
  readonly expiresAt?: string;
}

export type CreateStoredCredentialInput =
  | (CreateCredentialBase & {
      readonly kind: 'client_secret';
      readonly secretDigest: string;
    })
  | (CreateCredentialBase & {
      readonly kind: 'public_jwk';
      readonly algorithm: ServicePrincipalSigningAlgorithm;
      readonly publicJwk: unknown;
    });

export interface CredentialMutation extends PrincipalMutation {
  readonly credentialId: string;
}

export interface ServicePrincipalAccessBinding {
  readonly principalId: string;
  readonly grantId: string;
  readonly credentialId: string;
  readonly org: string;
  readonly app: string;
  readonly environment: string;
  readonly now: number;
}

export interface AssertionJtiInput {
  readonly credentialId: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly now: number;
}

export interface ServicePrincipalStore {
  createPrincipal(input: CreateServicePrincipalInput): Promise<ServicePrincipalRecord>;
  listPrincipals(org: string): Promise<readonly ServicePrincipalRecord[]>;
  getPrincipal(input: PrincipalRef): Promise<ServicePrincipalView | undefined>;
  revokePrincipal(input: PrincipalMutation): Promise<boolean>;
  createGrant(input: CreateServicePrincipalGrantInput): Promise<ServicePrincipalGrantRecord>;
  revokeGrant(input: GrantMutation): Promise<boolean>;
  createCredential(input: CreateStoredCredentialInput): Promise<ServicePrincipalCredentialRecord>;
  revokeCredential(input: CredentialMutation): Promise<boolean>;
  loadActiveClient(
    clientId: string,
    now: number,
  ): Promise<ActiveServicePrincipalClient | undefined>;
  validateAccessBinding(input: ServicePrincipalAccessBinding): Promise<boolean>;
  consumeAssertionJti(input: AssertionJtiInput): Promise<boolean>;
}

export type ServicePrincipalRuntime =
  | { readonly ready: true; readonly store: ServicePrincipalStore }
  | { readonly ready: false; readonly reason: 'schema_unavailable' };

type StoredCredential = ActiveServicePrincipalCredential;

export class InMemoryServicePrincipalStore implements ServicePrincipalStore {
  readonly #principals = new Map<string, ServicePrincipalRecord>();
  readonly #grants = new Map<string, ServicePrincipalGrantRecord>();
  readonly #credentials = new Map<string, StoredCredential>();
  readonly #assertionJtis = new Map<string, number>();
  readonly #now: () => Date;

  constructor(options: { readonly now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async createPrincipal(input: CreateServicePrincipalInput): Promise<ServicePrincipalRecord> {
    const now = currentServicePrincipalTimestamp(this.#now);
    const record: ServicePrincipalRecord = {
      principalId: `spn_${randomUUID()}`,
      org: validateSlug('org', input.org),
      name: validateServicePrincipalDisplayName('service-principal name', input.name),
      status: 'active',
      createdBySubject: validateServicePrincipalActor(input.actorSubject),
      createdAt: now,
      updatedAt: now,
    };
    this.#principals.set(record.principalId, record);
    return clone(record);
  }

  async listPrincipals(org: string): Promise<readonly ServicePrincipalRecord[]> {
    const normalizedOrg = validateSlug('org', org);
    return [...this.#principals.values()]
      .filter((record) => record.org === normalizedOrg)
      .sort((left, right) => left.principalId.localeCompare(right.principalId))
      .map(clone);
  }

  async getPrincipal(input: PrincipalRef): Promise<ServicePrincipalView | undefined> {
    const principal = this.#ownedPrincipal(input, false);
    if (principal === undefined) return undefined;
    return {
      principal: clone(principal),
      grants: [...this.#grants.values()]
        .filter((grant) => grant.principalId === principal.principalId)
        .sort((left, right) => left.grantId.localeCompare(right.grantId))
        .map(clone),
      credentials: [...this.#credentials.values()]
        .filter((credential) => credential.principalId === principal.principalId)
        .sort((left, right) => left.credentialId.localeCompare(right.credentialId))
        .map(publicServicePrincipalCredential),
    };
  }

  async revokePrincipal(input: PrincipalMutation): Promise<boolean> {
    validateServicePrincipalActor(input.actorSubject);
    const principal = this.#ownedPrincipal(input, false);
    if (principal === undefined) return false;
    if (principal.status === 'revoked') return true;
    const now = currentServicePrincipalTimestamp(this.#now);
    this.#principals.set(principal.principalId, {
      ...principal,
      status: 'revoked',
      updatedAt: now,
      revokedAt: now,
      revokedBySubject: input.actorSubject,
    });
    return true;
  }

  async createGrant(input: CreateServicePrincipalGrantInput): Promise<ServicePrincipalGrantRecord> {
    const principal = this.#requireActivePrincipal(input);
    const app = validateSlug('app', input.app);
    const environment = validateSlug('env', input.environment);
    if (
      [...this.#grants.values()].some(
        (grant) =>
          grant.principalId === principal.principalId &&
          grant.app === app &&
          grant.environment === environment &&
          grant.status === 'active',
      )
    ) {
      throw new Error('service principal already has an active grant for this app and environment');
    }
    const now = currentServicePrincipalTimestamp(this.#now);
    const record: ServicePrincipalGrantRecord = {
      grantId: `spg_${randomUUID()}`,
      principalId: principal.principalId,
      org: principal.org,
      app,
      environment,
      scopes: normalizeServicePrincipalScopes(input.scopes),
      status: 'active',
      createdBySubject: validateServicePrincipalActor(input.actorSubject),
      createdAt: now,
      updatedAt: now,
    };
    this.#grants.set(record.grantId, record);
    return clone(record);
  }

  async revokeGrant(input: GrantMutation): Promise<boolean> {
    validateServicePrincipalActor(input.actorSubject);
    const principal = this.#ownedPrincipal(input, true);
    const grant = this.#grants.get(input.grantId);
    if (
      principal === undefined ||
      grant === undefined ||
      grant.principalId !== principal.principalId
    ) {
      return false;
    }
    if (grant.status === 'revoked') return true;
    const now = currentServicePrincipalTimestamp(this.#now);
    this.#grants.set(grant.grantId, {
      ...grant,
      status: 'revoked',
      updatedAt: now,
      revokedAt: now,
      revokedBySubject: input.actorSubject,
    });
    return true;
  }

  async createCredential(
    input: CreateStoredCredentialInput,
  ): Promise<ServicePrincipalCredentialRecord> {
    const principal = this.#requireActivePrincipal(input);
    const nowDate = currentServicePrincipalDate(this.#now);
    const activeOfKind = [...this.#credentials.values()].filter(
      (credential) =>
        credential.principalId === principal.principalId &&
        credential.kind === input.kind &&
        servicePrincipalCredentialIsActive(credential, nowDate.getTime()),
    );
    if (activeOfKind.length >= 5) {
      throw new Error(`service principal may have at most five active ${input.kind} credentials`);
    }
    const createdAt = nowDate.toISOString();
    const expiresAt = normalizeServicePrincipalExpiry(input.expiresAt, nowDate);
    const base = {
      credentialId: `spc_${randomUUID()}`,
      principalId: principal.principalId,
      label: validateServicePrincipalDisplayName('credential label', input.label),
      status: 'active' as const,
      createdBySubject: validateServicePrincipalActor(input.actorSubject),
      createdAt,
      updatedAt: createdAt,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
    let stored: StoredCredential;
    if (input.kind === 'client_secret') {
      stored = {
        ...base,
        kind: 'client_secret',
        secretDigest: validateServicePrincipalSecretDigest(input.secretDigest),
      };
    } else {
      const validated = await validatePublicJwk(input.publicJwk, input.algorithm);
      const kid = validated.publicJwk.kid;
      stored = {
        ...base,
        kind: 'public_jwk',
        algorithm: validated.algorithm,
        publicJwk: validated.publicJwk,
        ...(typeof kid === 'string' ? { kid } : {}),
      };
    }
    this.#credentials.set(stored.credentialId, stored);
    return publicServicePrincipalCredential(stored);
  }

  async revokeCredential(input: CredentialMutation): Promise<boolean> {
    validateServicePrincipalActor(input.actorSubject);
    const principal = this.#ownedPrincipal(input, true);
    const credential = this.#credentials.get(input.credentialId);
    if (
      principal === undefined ||
      credential === undefined ||
      credential.principalId !== principal.principalId
    ) {
      return false;
    }
    if (credential.status === 'revoked') return true;
    const now = currentServicePrincipalTimestamp(this.#now);
    this.#credentials.set(credential.credentialId, {
      ...credential,
      status: 'revoked',
      updatedAt: now,
      revokedAt: now,
      revokedBySubject: input.actorSubject,
    });
    return true;
  }

  async loadActiveClient(
    clientId: string,
    now: number,
  ): Promise<ActiveServicePrincipalClient | undefined> {
    const principal = this.#principals.get(clientId);
    if (principal === undefined || principal.status !== 'active') return undefined;
    validateServicePrincipalEpoch('authorization time', now);
    return {
      principal: clone(principal),
      grants: [...this.#grants.values()]
        .filter((grant) => grant.principalId === clientId && grant.status === 'active')
        .map(clone),
      credentials: [...this.#credentials.values()]
        .filter(
          (credential) =>
            credential.principalId === clientId &&
            servicePrincipalCredentialIsActive(credential, now),
        )
        .map(clone),
    };
  }

  async validateAccessBinding(input: ServicePrincipalAccessBinding): Promise<boolean> {
    validateServicePrincipalEpoch('authorization time', input.now);
    const principal = this.#principals.get(input.principalId);
    const grant = this.#grants.get(input.grantId);
    const credential = this.#credentials.get(input.credentialId);
    return (
      principal?.status === 'active' &&
      principal.org === input.org &&
      grant?.status === 'active' &&
      grant.principalId === principal.principalId &&
      grant.org === input.org &&
      grant.app === input.app &&
      grant.environment === input.environment &&
      credential !== undefined &&
      credential.principalId === principal.principalId &&
      servicePrincipalCredentialIsActive(credential, input.now)
    );
  }

  async consumeAssertionJti(input: AssertionJtiInput): Promise<boolean> {
    validateServicePrincipalEpoch('assertion time', input.now);
    validateServicePrincipalEpoch('assertion expiry', input.expiresAt);
    if (input.expiresAt <= input.now) throw new Error('assertion expiry must be in the future');
    if (input.jti.length < 1 || input.jti.length > 200) {
      throw new Error('assertion jti must be between 1 and 200 characters');
    }
    if (!this.#credentials.has(input.credentialId)) {
      throw new Error('assertion credential does not exist');
    }
    for (const [key, expiresAt] of this.#assertionJtis) {
      if (expiresAt <= input.now) this.#assertionJtis.delete(key);
    }
    const key = `${input.credentialId}\u0000${input.jti}`;
    if (this.#assertionJtis.has(key)) return false;
    this.#assertionJtis.set(key, input.expiresAt);
    return true;
  }

  #ownedPrincipal(input: PrincipalRef, strict: boolean): ServicePrincipalRecord | undefined {
    const org = validateSlug('org', input.org);
    const principal = this.#principals.get(input.principalId);
    if (principal === undefined || principal.org === org) return principal;
    if (strict) throw new Error('service principal belongs to a different organization');
    return undefined;
  }

  #requireActivePrincipal(input: PrincipalRef): ServicePrincipalRecord {
    const principal = this.#ownedPrincipal(input, true);
    if (principal === undefined) throw new Error('service principal does not exist');
    if (principal.status !== 'active') throw new Error('service principal is revoked');
    return principal;
  }
}

export function publicServicePrincipalCredential(
  credential: ActiveServicePrincipalCredential,
): ServicePrincipalCredentialRecord {
  const { credentialId, principalId, kind, label, status, createdBySubject, createdAt, updatedAt } =
    credential;
  const lifecycle = {
    credentialId,
    principalId,
    kind,
    label,
    status,
    createdBySubject,
    createdAt,
    updatedAt,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
    ...(credential.revokedAt === undefined
      ? {}
      : {
          revokedAt: credential.revokedAt,
          ...(credential.revokedBySubject === undefined
            ? {}
            : { revokedBySubject: credential.revokedBySubject }),
        }),
  };
  return credential.kind === 'public_jwk'
    ? {
        ...lifecycle,
        kind: 'public_jwk',
        algorithm: credential.algorithm,
        ...(credential.kid === undefined ? {} : { kid: credential.kid }),
      }
    : { ...lifecycle, kind: 'client_secret' };
}

export function normalizeServicePrincipalScopes(values: readonly string[]): readonly string[] {
  const normalized = [...new Set(values.map(validateScope))].sort();
  if (normalized.length > 64) throw new Error('service-principal grant supports at most 64 scopes');
  return Object.freeze(normalized);
}

function validateScope(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 128 ||
    !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(normalized)
  ) {
    throw new Error('service-principal scope must be one valid 1-128 character OAuth scope token');
  }
  return normalized;
}

export function validateServicePrincipalDisplayName(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 80 || hasAsciiControlCharacters(normalized)) {
    throw new Error(`${label} must be between 1 and 80 printable characters`);
  }
  return normalized;
}

export function validateServicePrincipalActor(value: string): string {
  if (value.length < 1 || value.length > 512 || hasAsciiControlCharacters(value)) {
    throw new Error('invalid service-principal actor');
  }
  return value;
}

export function validateServicePrincipalSecretDigest(value: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').length !== 32) {
    throw new Error('service-principal secret digest must be a SHA-256 base64url value');
  }
  return value;
}

export function normalizeServicePrincipalExpiry(
  value: string | undefined,
  now: Date,
): string | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= now.getTime()) {
    throw new Error('service-principal credential expiresAt must be a future ISO timestamp');
  }
  return parsed.toISOString();
}

function servicePrincipalCredentialIsActive(
  credential: ActiveServicePrincipalCredential,
  now: number,
): boolean {
  return (
    credential.status === 'active' &&
    (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > now)
  );
}

export function currentServicePrincipalDate(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime()))
    throw new Error('service-principal store clock is invalid');
  return value;
}

function currentServicePrincipalTimestamp(now: () => Date): string {
  return currentServicePrincipalDate(now).toISOString();
}

export function validateServicePrincipalEpoch(label: string, value: number): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer epoch millisecond`);
  }
}

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

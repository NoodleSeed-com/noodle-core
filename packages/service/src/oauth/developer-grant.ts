import { randomUUID } from 'node:crypto';

import {
  capabilitiesForDeveloperResource,
  type DeveloperCapability,
  isDeveloperCapability,
  isDeveloperResource,
} from '@noodle-borg/developer-mcp';

const DEVELOPER_GRANT_VERSION = 2 as const;
const DEVELOPER_GRANT_ACCESS_MODEL = 'live_user' as const;

export interface DeveloperAccessGrant {
  readonly version: typeof DEVELOPER_GRANT_VERSION;
  readonly id: string;
  readonly clientId: string;
  readonly subject: string;
  readonly resource: string;
  readonly accessModel: typeof DEVELOPER_GRANT_ACCESS_MODEL;
  readonly capabilities: readonly DeveloperCapability[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface CreateDeveloperAccessGrant {
  readonly clientId: string;
  readonly subject: string;
  readonly resource: string;
  readonly capabilities: readonly DeveloperCapability[];
  readonly expiresAt?: string;
}

export interface ActiveDeveloperGrantLookup {
  readonly clientId: string;
  readonly subject: string;
  readonly resource: string;
  readonly at?: string;
}

export interface DeveloperGrantStore {
  getOrCreateActive(input: CreateDeveloperAccessGrant): Promise<DeveloperAccessGrant>;
  getActive(input: ActiveDeveloperGrantLookup): Promise<DeveloperAccessGrant | undefined>;
  get(id: string): Promise<DeveloperAccessGrant | undefined>;
  revoke(id: string, at: string): Promise<DeveloperAccessGrant | undefined>;
}

export interface ActiveDeveloperGrantInput {
  readonly subject: string;
  readonly clientId: string;
  readonly resource: string;
  readonly at: string;
}

export interface DeveloperGrantFactoryOptions {
  readonly now?: () => string;
  readonly id?: () => string;
}

export type InMemoryDeveloperGrantStoreOptions = DeveloperGrantFactoryOptions;

export class InMemoryDeveloperGrantStore implements DeveloperGrantStore {
  readonly #records = new Map<string, DeveloperAccessGrant>();
  readonly #now: () => string;
  readonly #id: () => string;

  constructor(options: InMemoryDeveloperGrantStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? randomUUID;
  }

  async getOrCreateActive(input: CreateDeveloperAccessGrant): Promise<DeveloperAccessGrant> {
    const normalized = normalizeCreateInput(input);
    const at = normalizeDeveloperGrantTimestamp('authorization time', this.#now());
    const existing = await this.getActive({
      clientId: normalized.clientId,
      subject: normalized.subject,
      resource: normalized.resource,
      at,
    });
    if (existing !== undefined) return existing;

    const record = createDeveloperAccessGrantRecord(normalized, {
      now: () => at,
      id: this.#id,
    });
    if (this.#records.has(record.id)) {
      throw new Error(`developer grant "${record.id}" already exists`);
    }
    this.#records.set(record.id, record);
    return cloneGrant(record);
  }

  async getActive(input: ActiveDeveloperGrantLookup): Promise<DeveloperAccessGrant | undefined> {
    const at = input.at ?? this.#now();
    for (const record of this.#records.values()) {
      if (
        activeDeveloperGrant(record, {
          clientId: input.clientId,
          subject: input.subject,
          resource: input.resource,
          at,
        })
      ) {
        return cloneGrant(record);
      }
    }
    return undefined;
  }

  async get(id: string): Promise<DeveloperAccessGrant | undefined> {
    const record = this.#records.get(id);
    return record === undefined ? undefined : cloneGrant(record);
  }

  async revoke(id: string, at: string): Promise<DeveloperAccessGrant | undefined> {
    const record = this.#records.get(id);
    if (record === undefined) return undefined;
    if (record.revokedAt !== undefined) return cloneGrant(record);

    const revokedAt = normalizeDeveloperGrantTimestamp('revokedAt', at);
    if (revokedAt < record.createdAt) {
      throw new Error('developer grant revokedAt must not be before createdAt');
    }
    const revoked = normalizeDeveloperAccessGrant({ ...record, revokedAt, updatedAt: revokedAt });
    this.#records.set(id, revoked);
    return cloneGrant(revoked);
  }
}

export function activeDeveloperGrant(
  grant: DeveloperAccessGrant,
  input: ActiveDeveloperGrantInput,
): boolean {
  const at = normalizeDeveloperGrantTimestamp('authorization time', input.at);
  return (
    grant.version === DEVELOPER_GRANT_VERSION &&
    grant.accessModel === DEVELOPER_GRANT_ACCESS_MODEL &&
    grant.subject === input.subject &&
    grant.clientId === input.clientId &&
    grant.resource === normalizeDeveloperResource(input.resource) &&
    grant.revokedAt === undefined &&
    (grant.expiresAt === undefined || grant.expiresAt > at)
  );
}

export function createDeveloperAccessGrantRecord(
  input: CreateDeveloperAccessGrant,
  options: DeveloperGrantFactoryOptions = {},
): DeveloperAccessGrant {
  const createdAt = normalizeDeveloperGrantTimestamp(
    'createdAt',
    options.now?.() ?? new Date().toISOString(),
  );
  const normalized = normalizeCreateInput(input);
  return normalizeDeveloperAccessGrant({
    version: DEVELOPER_GRANT_VERSION,
    id: options.id?.() ?? randomUUID(),
    clientId: normalized.clientId,
    subject: normalized.subject,
    resource: normalized.resource,
    accessModel: DEVELOPER_GRANT_ACCESS_MODEL,
    capabilities: normalized.capabilities,
    createdAt,
    updatedAt: createdAt,
    ...(normalized.expiresAt === undefined ? {} : { expiresAt: normalized.expiresAt }),
  });
}

export function normalizeDeveloperAccessGrant(grant: DeveloperAccessGrant): DeveloperAccessGrant {
  const createdAt = normalizeDeveloperGrantTimestamp('createdAt', grant.createdAt);
  const updatedAt = normalizeDeveloperGrantTimestamp('updatedAt', grant.updatedAt);
  const expiresAt =
    grant.expiresAt === undefined
      ? undefined
      : normalizeDeveloperGrantTimestamp('expiresAt', grant.expiresAt);
  const revokedAt =
    grant.revokedAt === undefined
      ? undefined
      : normalizeDeveloperGrantTimestamp('revokedAt', grant.revokedAt);
  if (grant.version !== DEVELOPER_GRANT_VERSION)
    throw new Error('unsupported developer grant version');
  if (grant.accessModel !== DEVELOPER_GRANT_ACCESS_MODEL) {
    throw new Error('unsupported developer grant access model');
  }
  if (updatedAt < createdAt)
    throw new Error('developer grant updatedAt must not be before createdAt');
  if (expiresAt !== undefined && expiresAt <= createdAt) {
    throw new Error('developer grant expiresAt must be after createdAt');
  }
  if (revokedAt !== undefined && revokedAt < createdAt) {
    throw new Error('developer grant revokedAt must not be before createdAt');
  }

  const resource = normalizeDeveloperResource(grant.resource);
  return freezeGrant({
    version: DEVELOPER_GRANT_VERSION,
    id: validateScalar('developer grant ID', grant.id),
    clientId: validateScalar('OAuth client ID', grant.clientId),
    subject: validateScalar('subject', grant.subject),
    resource,
    accessModel: DEVELOPER_GRANT_ACCESS_MODEL,
    capabilities: normalizeCapabilities(resource, grant.capabilities),
    createdAt,
    updatedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  });
}

function normalizeCreateInput(input: CreateDeveloperAccessGrant): CreateDeveloperAccessGrant {
  const resource = normalizeDeveloperResource(input.resource);
  return {
    clientId: validateScalar('OAuth client ID', input.clientId),
    subject: validateScalar('subject', input.subject),
    resource,
    capabilities: normalizeCapabilities(resource, input.capabilities),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: normalizeDeveloperGrantTimestamp('expiresAt', input.expiresAt) }),
  };
}

function validateScalar(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    throw new Error(`${label} must be between 1 and 2048 characters`);
  }
  return normalized;
}

function normalizeDeveloperResource(resource: string): string {
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new Error('invalid developer resource');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    !isDeveloperResource(parsed.pathname) ||
    parsed.pathname.endsWith('/') ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw new Error('invalid developer resource');
  }
  return parsed.toString();
}

export function normalizeDeveloperGrantTimestamp(label: string, value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an ISO timestamp`);
  return parsed.toISOString();
}

function normalizeCapabilities(
  resource: string,
  capabilities: readonly DeveloperCapability[],
): readonly DeveloperCapability[] {
  if (capabilities.length === 0)
    throw new Error('developer grant requires at least one capability');
  const allowed = new Set(capabilitiesForDeveloperResource(resource));
  const normalized = [...new Set(capabilities)].sort();
  for (const capability of normalized) {
    if (!isDeveloperCapability(capability) || !allowed.has(capability)) {
      throw new Error(`invalid developer capability "${String(capability)}" for resource`);
    }
  }
  return Object.freeze(normalized);
}

function freezeGrant(grant: DeveloperAccessGrant): DeveloperAccessGrant {
  return Object.freeze({
    ...grant,
    capabilities: Object.freeze([...grant.capabilities]),
  });
}

function cloneGrant(grant: DeveloperAccessGrant): DeveloperAccessGrant {
  return freezeGrant(grant);
}

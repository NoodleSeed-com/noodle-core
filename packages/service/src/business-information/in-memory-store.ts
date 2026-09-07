import { randomUUID } from 'node:crypto';
import type {
  BusinessGrant,
  BusinessInformationStore,
  GrantMutationResult,
  InstallationCreateResult,
  InstallationScope,
  ManagedRequestActivity,
  ManagedRequestRecord,
  RequestCreateResult,
  RequestExportPage,
  RequestMutationResult,
  RequestPage,
  SolutionInstallation,
} from './contracts.js';
import {
  activityFromRecord,
  applyRequestOperation,
  cloneActivity,
  cloneGrant,
  cloneInstallation,
  cloneRecord,
  deletedRecord,
  idempotencyDigest,
  initialRecord,
  installationFingerprint,
  normalizeInstallationInput,
  permissionsForBusinessRole,
  requestFingerprint,
  validateCollectionEnabled,
  validateExpectedRevision,
} from './model.js';
import {
  afterCursor,
  compareRecords,
  decodeCursor,
  encodeCursor,
  recordKey,
  scopeKey,
} from './pagination.js';
import {
  boundedExportPageSize,
  boundedPageSize,
  validateEmail,
  validateScalar,
  validateScope,
} from './validation.js';

interface IdempotencyRecord {
  readonly fingerprint: string;
  readonly recordKey: string;
}

export interface InMemoryBusinessInformationStoreOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
  readonly publicId?: () => string;
}

/** Process-local development/test adapter. Hosted services must use the PostgreSQL adapter. */
export class InMemoryBusinessInformationStore implements BusinessInformationStore {
  readonly #installations = new Map<string, SolutionInstallation>();
  readonly #installationIds = new Map<string, string>();
  readonly #publicIds = new Map<string, string>();
  readonly #installationFingerprints = new Map<string, string>();
  readonly #grants = new Map<string, BusinessGrant>();
  readonly #records = new Map<string, ManagedRequestRecord>();
  readonly #activities = new Map<string, ManagedRequestActivity[]>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #publicId: () => string;

  constructor(options: InMemoryBusinessInformationStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#publicId = options.publicId ?? (() => `sol_${randomUUID().replaceAll('-', '')}`);
  }

  async createInstallation(
    input: Parameters<BusinessInformationStore['createInstallation']>[0],
  ): Promise<InstallationCreateResult> {
    const normalized = normalizeInstallationInput(input);
    const key = scopeKey(normalized.scope);
    return this.#withLock(
      `installation:${normalized.scope.org}:${normalized.scope.installationId}`,
      async () => {
        const existingKey = this.#installationIds.get(
          installationIdKey(normalized.scope.org, normalized.scope.installationId),
        );
        const existing =
          existingKey === undefined ? undefined : this.#installations.get(existingKey);
        if (existing !== undefined) {
          return {
            disposition:
              existingKey === key &&
              this.#installationFingerprints.get(key) === installationFingerprint(normalized)
                ? 'replayed'
                : 'conflict',
            installation: cloneInstallation(existing),
          };
        }
        const now = this.#now().toISOString();
        const installation: SolutionInstallation = {
          scope: { ...normalized.scope },
          publicId: this.#uniquePublicId(),
          profileKey: normalized.profileKey,
          profileVersion: normalized.profileVersion,
          managedCollections: [...normalized.managedCollections],
          retentionDays: normalized.retentionDays,
          revision: 1,
          createdAt: now,
          createdBySubject: normalized.actorSubject,
          updatedAt: now,
          updatedBySubject: normalized.actorSubject,
        };
        this.#installations.set(key, installation);
        this.#installationIds.set(
          installationIdKey(normalized.scope.org, normalized.scope.installationId),
          key,
        );
        this.#publicIds.set(installation.publicId, key);
        this.#installationFingerprints.set(key, installationFingerprint(normalized));
        const administrator: BusinessGrant = {
          scope: { ...normalized.scope },
          subject: normalized.actorSubject,
          ...(normalized.actorEmail === undefined ? {} : { email: normalized.actorEmail }),
          role: 'administrator',
          revision: 1,
          createdAt: now,
          createdBySubject: normalized.actorSubject,
          updatedAt: now,
          updatedBySubject: normalized.actorSubject,
        };
        this.#grants.set(grantKey(normalized.scope, normalized.actorSubject), administrator);
        return { disposition: 'created', installation: cloneInstallation(installation) };
      },
    );
  }

  getInstallation(scope: InstallationScope): Promise<SolutionInstallation | undefined> {
    const found = this.#installations.get(scopeKey(validateScope(scope)));
    return Promise.resolve(found === undefined ? undefined : cloneInstallation(found));
  }

  getInstallationById(
    org: string,
    installationId: string,
  ): Promise<SolutionInstallation | undefined> {
    const key = this.#installationIds.get(
      installationIdKey(
        validateScalar('organization', org, 63),
        validateScalar('installation', installationId, 63),
      ),
    );
    const found = key === undefined ? undefined : this.#installations.get(key);
    return Promise.resolve(found === undefined ? undefined : cloneInstallation(found));
  }

  resolveInstallationByPublicId(publicId: string): Promise<SolutionInstallation | undefined> {
    const key = this.#publicIds.get(validateScalar('public installation id', publicId, 128));
    const found = key === undefined ? undefined : this.#installations.get(key);
    return Promise.resolve(found === undefined ? undefined : cloneInstallation(found));
  }

  listInstallations(org: string): Promise<readonly SolutionInstallation[]> {
    const normalized = validateScalar('organization', org, 63);
    return Promise.resolve(
      [...this.#installations.values()]
        .filter((installation) => installation.scope.org === normalized)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(cloneInstallation),
    );
  }

  getGrant(scope: InstallationScope, subject: string): Promise<BusinessGrant | undefined> {
    const found = this.#grants.get(grantKey(validateScope(scope), subject));
    return Promise.resolve(found === undefined ? undefined : cloneGrant(found));
  }

  listGrants(scope: InstallationScope): Promise<readonly BusinessGrant[]> {
    const prefix = `${scopeKey(validateScope(scope))}\0`;
    return Promise.resolve(
      [...this.#grants.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, grant]) => cloneGrant(grant))
        .sort((left, right) => left.subject.localeCompare(right.subject)),
    );
  }

  async setGrant(
    input: Parameters<BusinessInformationStore['setGrant']>[0],
  ): Promise<GrantMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const subject = validateScalar('grant subject', input.subject, 256);
    const actor = validateScalar('actor subject', input.actorSubject, 256);
    permissionsForBusinessRole(input.role);
    const scope = validateScope(input.scope);
    const key = grantKey(scope, subject);
    return this.#withLock(`grants:${scopeKey(scope)}`, async () => {
      if (!(await this.getInstallation(input.scope)))
        return { ok: false, reason: 'not_found', currentRevision: 0 };
      const current = this.#grants.get(key);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision };
      }
      if (
        current?.role === 'administrator' &&
        current.revokedAt === undefined &&
        input.role !== 'administrator' &&
        this.#liveAdministratorCount(scope) === 1
      ) {
        return { ok: false, reason: 'last_administrator', currentRevision };
      }
      const now = this.#now().toISOString();
      const grant: BusinessGrant = {
        scope: { ...input.scope },
        subject,
        email: validateEmail(input.email),
        role: input.role,
        revision: currentRevision + 1,
        createdAt: current?.createdAt ?? now,
        createdBySubject: current?.createdBySubject ?? actor,
        updatedAt: now,
        updatedBySubject: actor,
      };
      this.#grants.set(key, grant);
      return { ok: true, grant: cloneGrant(grant) };
    });
  }

  async revokeGrant(
    input: Parameters<BusinessInformationStore['revokeGrant']>[0],
  ): Promise<GrantMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const scope = validateScope(input.scope);
    const key = grantKey(scope, input.subject);
    return this.#withLock(`grants:${scopeKey(scope)}`, async () => {
      const current = this.#grants.get(key);
      if (current === undefined) return { ok: false, reason: 'not_found', currentRevision: 0 };
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      if (
        current.role === 'administrator' &&
        current.revokedAt === undefined &&
        this.#liveAdministratorCount(scope) === 1
      ) {
        return {
          ok: false,
          reason: 'last_administrator',
          currentRevision: current.revision,
        };
      }
      const now = this.#now().toISOString();
      const grant: BusinessGrant = {
        ...current,
        revision: current.revision + 1,
        updatedAt: now,
        updatedBySubject: validateScalar('actor subject', input.actorSubject, 256),
        revokedAt: now,
      };
      this.#grants.set(key, grant);
      return { ok: true, grant: cloneGrant(grant) };
    });
  }

  async createRequest(
    input: Parameters<BusinessInformationStore['createRequest']>[0],
  ): Promise<RequestCreateResult> {
    const idempotencyKey = idempotencyDigest(input.idempotencyKey);
    const installation = await this.#requiredInstallation(input.scope);
    validateCollectionEnabled(installation, input.collectionKey);
    const key = `${scopeKey(input.scope)}\0${input.collectionKey}\0${idempotencyKey}`;
    return this.#withLock(`request-create:${key}`, async () => {
      const candidate = initialRecord({
        installation,
        collectionKey: input.collectionKey,
        id: this.#id(),
        payload: input.payload,
        origin: input.origin,
        actorSubject: input.actorSubject,
        now: this.#now(),
      });
      const fingerprint = requestFingerprint({
        collectionKey: candidate.collectionKey,
        payload: candidate.content?.payload,
        origin: candidate.origin,
        actorSubject: candidate.createdBySubject,
      });
      const replay = this.#idempotency.get(key);
      if (replay !== undefined) {
        const existing = this.#records.get(replay.recordKey);
        if (existing === undefined)
          throw new Error('idempotency record points to a missing request');
        return {
          disposition: replay.fingerprint === fingerprint ? 'replayed' : 'conflict',
          record: cloneRecord(existing),
        };
      }
      const currentKey = recordKey(input.scope, candidate.collectionKey, candidate.id);
      this.#records.set(currentKey, candidate);
      this.#activities.set(currentKey, [activityFromRecord(candidate, 'created')]);
      this.#idempotency.set(key, { fingerprint, recordKey: currentKey });
      return { disposition: 'created', record: cloneRecord(candidate) };
    });
  }

  #liveAdministratorCount(scope: InstallationScope): number {
    const prefix = `${scopeKey(scope)}\0`;
    return [...this.#grants.entries()].filter(
      ([key, grant]) =>
        key.startsWith(prefix) && grant.role === 'administrator' && grant.revokedAt === undefined,
    ).length;
  }

  async getRequest(
    scope: InstallationScope,
    collectionKey: string,
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ManagedRequestRecord | undefined> {
    const installation = await this.#requiredInstallation(scope);
    const collection = validateCollectionEnabled(installation, collectionKey);
    const record = this.#records.get(
      recordKey(scope, collection.key, validateScalar('record id', id, 128)),
    );
    if (record === undefined || (record.deletedAt !== undefined && options.includeDeleted !== true))
      return undefined;
    return cloneRecord(record);
  }

  async listRequests(
    input: Parameters<BusinessInformationStore['listRequests']>[0],
  ): Promise<RequestPage> {
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const limit = boundedPageSize(input.limit);
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, {
            kind: 'list',
            scope: input.scope,
            collectionKey: collection.key,
          });
    const records = this.#matchingRecords(input.scope, collection.key)
      .filter((record) => input.includeDeleted === true || record.deletedAt === undefined)
      .filter((record) => input.status === undefined || record.status === input.status)
      .filter(
        (record) =>
          input.assigneeSubject === undefined || record.assigneeSubject === input.assigneeSubject,
      )
      .filter((record) => cursor === undefined || afterCursor(record, cursor));
    return page(records, limit, 'list', input.scope, collection.key);
  }

  async mutateRequest(
    input: Parameters<BusinessInformationStore['mutateRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const key = recordKey(input.scope, collection.key, validateScalar('record id', input.id, 128));
    return this.#withLock(`request:${key}`, async () => {
      const current = this.#records.get(key);
      if (current === undefined || current.deletedAt !== undefined) {
        return { ok: false, reason: 'not_found', currentRevision: 0 };
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      const applied = applyRequestOperation(
        current,
        input.operation,
        input.actorSubject,
        this.#now(),
        this.#id,
      );
      if (applied === undefined) {
        return { ok: false, reason: 'invalid_transition', currentRevision: current.revision };
      }
      this.#records.set(key, applied.record);
      this.#activities.get(key)?.push(activityFromRecord(applied.record, applied.activityKind));
      return { ok: true, record: cloneRecord(applied.record) };
    });
  }

  async deleteRequest(
    input: Parameters<BusinessInformationStore['deleteRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const key = recordKey(input.scope, collection.key, validateScalar('record id', input.id, 128));
    return this.#withLock(`request:${key}`, () =>
      Promise.resolve(
        this.#eraseRecord(key, input.expectedRevision, input.actorSubject, 'customer_request'),
      ),
    );
  }

  listActivity(
    scope: InstallationScope,
    collectionKey: string,
    id: string,
  ): Promise<readonly ManagedRequestActivity[]> {
    const key = recordKey(
      validateScope(scope),
      collectionKey,
      validateScalar('record id', id, 128),
    );
    return Promise.resolve((this.#activities.get(key) ?? []).map(cloneActivity));
  }

  async exportRequests(
    input: Parameters<BusinessInformationStore['exportRequests']>[0],
  ): Promise<RequestExportPage> {
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const limit = boundedExportPageSize(input.limit);
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, {
            kind: 'export',
            scope: input.scope,
            collectionKey: collection.key,
          });
    const snapshotAt = cursor?.snapshotAt ?? this.#now().toISOString();
    if (snapshotAt === undefined) throw new Error('export cursor is missing its snapshot');
    const records = this.#matchingRecords(input.scope, collection.key)
      .filter((record) => record.createdAt <= snapshotAt)
      .filter((record) => input.includeDeleted === true || record.deletedAt === undefined)
      .filter((record) => cursor === undefined || afterCursor(record, cursor));
    return {
      ...page(records, limit, 'export', input.scope, collection.key, snapshotAt),
      snapshotAt,
    };
  }

  async purgeExpired(
    input: Parameters<BusinessInformationStore['purgeExpired']>[0],
  ): Promise<number> {
    const limit = boundedPageSize(input.limit);
    const scope = input.scope === undefined ? undefined : scopeKey(validateScope(input.scope));
    const now = this.#now();
    const candidates = [...this.#records.entries()]
      .filter(
        ([key, record]) =>
          (scope === undefined || key.startsWith(`${scope}\0`)) &&
          record.deletedAt === undefined &&
          record.retentionExpiresAt <= now.toISOString(),
      )
      .slice(0, limit);
    let purged = 0;
    for (const [key, record] of candidates) {
      const result = await this.#withLock(`request:${key}`, () =>
        Promise.resolve(
          this.#eraseRecord(key, record.revision, 'system:retention', 'retention_expired'),
        ),
      );
      if (result.ok) purged += 1;
    }
    return purged;
  }

  #matchingRecords(scope: InstallationScope, collectionKey: string): ManagedRequestRecord[] {
    const prefix = `${scopeKey(scope)}\0${collectionKey}\0`;
    return [...this.#records.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record)
      .sort(compareRecords);
  }

  #eraseRecord(
    key: string,
    expectedRevision: number,
    actorSubject: string,
    reason: 'customer_request' | 'retention_expired',
  ): RequestMutationResult {
    const current = this.#records.get(key);
    if (current === undefined || current.deletedAt !== undefined) {
      return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
    }
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'conflict', currentRevision: current.revision };
    }
    const erased = deletedRecord(current, actorSubject, this.#now(), reason);
    this.#records.set(key, erased);
    const erasedHistory = (this.#activities.get(key) ?? []).map((activity) => {
      const { content: ignored, ...metadata } = activity;
      void ignored;
      return metadata;
    });
    this.#activities.set(key, [
      ...erasedHistory,
      activityFromRecord(erased, reason === 'customer_request' ? 'deleted' : 'retention_expired'),
    ]);
    return { ok: true, record: cloneRecord(erased) };
  }

  async #requiredInstallation(scope: InstallationScope): Promise<SolutionInstallation> {
    const installation = await this.getInstallation(scope);
    if (installation === undefined) throw new Error('solution installation was not found');
    return installation;
  }

  #uniquePublicId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = validateScalar('public installation id', this.#publicId(), 128);
      if (!this.#publicIds.has(candidate)) return candidate;
    }
    throw new Error('could not allocate a unique public installation id');
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (value: void | PromiseLike<void>) => void = () => void 0;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release(undefined);
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }
}

function installationIdKey(org: string, installationId: string): string {
  return `${org}\0${installationId}`;
}

function grantKey(scope: InstallationScope, subject: string): string {
  return `${scopeKey(scope)}\0${validateScalar('grant subject', subject, 256)}`;
}

function page(
  records: readonly ManagedRequestRecord[],
  limit: number,
  kind: 'list' | 'export',
  scope: InstallationScope,
  collectionKey: string,
  snapshotAt?: string,
): RequestPage {
  const selected = records.slice(0, limit).map(cloneRecord);
  const last = selected.at(-1);
  const hasMore = records.length > limit;
  return {
    records: selected,
    ...(hasMore && last !== undefined
      ? {
          nextCursor: encodeCursor({
            version: 1,
            kind,
            scope: scopeKey(scope),
            collectionKey,
            lastCreatedAt: last.createdAt,
            lastId: last.id,
            ...(snapshotAt === undefined ? {} : { snapshotAt }),
          }),
        }
      : {}),
  };
}

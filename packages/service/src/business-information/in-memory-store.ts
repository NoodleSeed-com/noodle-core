import { randomUUID } from 'node:crypto';
import { memoryActivityPage } from './activity-pagination.js';
import { collectionControlEnabled } from './collection-controls.js';
import type {
  AcceptedBusinessInformationSchema,
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
  InMemoryInstallationLifecycle,
  type InstallationApplicationResolver,
} from './in-memory-installation-lifecycle.js';
import { InMemoryBusinessInvitations } from './in-memory-invitations.js';
import { BusinessMemoryLocks } from './in-memory-locks.js';
import type {
  IdempotencyRecord,
  InMemoryBusinessInformationStoreOptions,
} from './in-memory-store-types.js';
import {
  InstallationCapacityError,
  MAX_RETAINED_INSTALLATIONS_PER_ORG,
} from './installation-capacity.js';
import { migrateLegacyRequestRecord } from './legacy-request-migration.js';
import type { ManagedDefinitionResolver } from './managed-releases.js';
import {
  activityFromRecord,
  applyRequestOperation,
  cloneGrant,
  cloneRecord,
  deletedRecord,
  effectiveInstallation,
  idempotencyDigest,
  initialRecord,
  installationFingerprint,
  managedInstallationIntentMatches,
  normalizeInstallationInput,
  permissionsForBusinessRole,
  requestFingerprint,
  validateCollectionEnabled,
  validateExpectedRevision,
  validateStoredRecord,
} from './model.js';
import { matchesNativeQueryMetadata, planNativeQuery, runNativeQuery } from './native-query.js';
import { commitNativeMemoryRecord, NativeStorageBudget } from './native-storage-budget.js';
import {
  afterCursor,
  compareRecords,
  decodeCursor,
  grantKey,
  installationIdKey,
  page,
  recordKey,
  scopeKey,
} from './pagination.js';
import {
  BusinessPrincipalAuthority,
  type BusinessPrincipalProvider,
} from './principal-authority.js';
import {
  boundedExportPageSize,
  boundedPageSize,
  validateEmail,
  validateScalar,
  validateScope,
} from './validation.js';

export type { InMemoryBusinessInformationStoreOptions } from './in-memory-store-types.js';

/** Process-local development/test adapter. Hosted services must use the PostgreSQL adapter. */
export class InMemoryBusinessInformationStore implements BusinessInformationStore {
  readonly #installations = new Map<string, SolutionInstallation>();
  readonly #installationIds = new Map<string, string>();
  readonly #publicIds = new Map<string, string>();
  readonly #installationFingerprints = new Map<string, string>();
  readonly #grants = new Map<string, BusinessGrant>();
  readonly #invitations: InMemoryBusinessInvitations;
  readonly #lifecycle: InMemoryInstallationLifecycle;
  readonly #principals = new BusinessPrincipalAuthority();
  readonly #custody = new NativeStorageBudget();
  readonly #records = new Map<string, ManagedRequestRecord>();
  readonly #activities = new Map<string, ManagedRequestActivity[]>();
  readonly #idempotency = new Map<string, IdempotencyRecord>();
  readonly #locks = new BusinessMemoryLocks();
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #publicId: () => string;
  readonly #managedDefinition: ManagedDefinitionResolver | undefined;

  constructor(options: InMemoryBusinessInformationStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.#publicId = options.publicId ?? (() => `sol_${randomUUID().replaceAll('-', '')}`);
    this.#managedDefinition = options.managedDefinition;
    this.#lifecycle = new InMemoryInstallationLifecycle({
      installations: this.#installations,
      getGrant: (scope, subject) => this.#grants.get(grantKey(scope, subject)),
      withLock: (key, operation) => this.#locks.run(key, operation),
      now: this.#now,
      managedDefinition: this.#managedDefinition,
    });
    this.#invitations = new InMemoryBusinessInvitations({
      now: this.#now,
      getInstallation: (scope) => this.getInstallation(scope),
      getGrant: (scope, subject) => this.getGrant(scope, subject),
      putGrant: (grant) => this.#grants.set(grantKey(grant.scope, grant.subject), grant),
      withGrantLock: (scope, operation) => this.#locks.run(`grants:${scopeKey(scope)}`, operation),
      liveAdministratorCount: (scope) => this.#liveAdministratorCount(scope),
    });
  }

  configurePrincipalAuthority(provider: BusinessPrincipalProvider | undefined): void {
    this.#principals.configure(provider);
  }

  async listEligibleAssignees(scope: InstallationScope) {
    return this.#principals.eligible(await this.listGrants(scope));
  }

  getBusinessNotice(scope: InstallationScope) {
    return this.#lifecycle.getBusinessNotice(scope);
  }
  setBusinessNotice(input: Parameters<BusinessInformationStore['setBusinessNotice']>[0]) {
    return this.#lifecycle.setBusinessNotice(input);
  }

  async createInstallation(
    input: Parameters<BusinessInformationStore['createInstallation']>[0],
  ): Promise<InstallationCreateResult> {
    const normalized = normalizeInstallationInput(input, this.#managedDefinition);
    const key = scopeKey(normalized.scope);
    return this.#locks.run(`installations:${normalized.scope.org}`, async () => {
      const existingKey = this.#installationIds.get(
        installationIdKey(normalized.scope.org, normalized.scope.installationId),
      );
      const existing = existingKey === undefined ? undefined : this.#installations.get(existingKey);
      if (existing !== undefined) {
        return {
          disposition:
            existingKey === key &&
            (this.#installationFingerprints.get(key) === installationFingerprint(normalized) ||
              managedInstallationIntentMatches(existing, normalized))
              ? 'replayed'
              : 'conflict',
          installation: effectiveInstallation(existing, this.#managedDefinition),
        };
      }
      if (
        [...this.#installations.values()].filter(
          (entry) => entry.scope.org === normalized.scope.org,
        ).length >= MAX_RETAINED_INSTALLATIONS_PER_ORG
      )
        throw new InstallationCapacityError();
      const now = this.#now().toISOString();
      const installation: SolutionInstallation = {
        scope: { ...normalized.scope },
        publicId: this.#uniquePublicId(),
        profileKey: normalized.profileKey,
        profileVersion: normalized.profileVersion,
        managedCollections: [...normalized.managedCollections],
        definition: structuredClone(normalized.definition),
        retentionDays: normalized.retentionDays,
        intakeActive: true,
        applicationGeneration: 'pending',
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
      return {
        disposition: 'created',
        installation: effectiveInstallation(installation, this.#managedDefinition),
      };
    });
  }

  getInstallation(scope: InstallationScope): Promise<SolutionInstallation | undefined> {
    return this.#lifecycle.getInstallation(scope);
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
    return Promise.resolve(
      found === undefined ? undefined : effectiveInstallation(found, this.#managedDefinition),
    );
  }

  resolveInstallationByPublicId(publicId: string): Promise<SolutionInstallation | undefined> {
    const key = this.#publicIds.get(validateScalar('public installation id', publicId, 128));
    const found = key === undefined ? undefined : this.#installations.get(key);
    return Promise.resolve(
      found === undefined ? undefined : effectiveInstallation(found, this.#managedDefinition),
    );
  }

  listInstallations(org: string): Promise<readonly SolutionInstallation[]> {
    return this.#lifecycle.listInstallations(org);
  }

  listInstallationsForSubject(subject: string) {
    const normalized = validateScalar('identity subject', subject, 256);
    return Promise.resolve(
      [...this.#grants.values()]
        .filter((grant) => grant.subject === normalized && grant.revokedAt === undefined)
        .map((grant) => {
          const installation = this.#installations.get(scopeKey(grant.scope));
          if (installation === undefined) throw new Error('business grant installation is missing');
          return {
            installation: effectiveInstallation(installation, this.#managedDefinition),
            grant: cloneGrant(grant),
          };
        })
        .sort((left, right) =>
          left.installation.createdAt.localeCompare(right.installation.createdAt),
        ),
    );
  }

  configureApplicationLifecycle(resolve: InstallationApplicationResolver) {
    this.#lifecycle.configureApplicationLifecycle(resolve);
  }
  bindApplication(scope: InstallationScope, generation: string) {
    return this.#lifecycle.bindApplication(scope, generation);
  }
  pauseApplication(org: string, app: string, at: string, retired = false) {
    return this.#lifecycle.pauseApplication(org, app, at, retired);
  }
  setIntakeState(input: Parameters<BusinessInformationStore['setIntakeState']>[0]) {
    return this.#lifecycle.setIntakeState(input);
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
    return this.#locks.run(`grants:${scopeKey(scope)}`, async () => {
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
    return this.#locks.run(`grants:${scopeKey(scope)}`, async () => {
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

  async createInvitation(
    input: Parameters<BusinessInformationStore['createInvitation']>[0],
  ): ReturnType<BusinessInformationStore['createInvitation']> {
    return this.#invitations.create(input);
  }

  listInvitations(scope: Parameters<BusinessInformationStore['listInvitations']>[0]) {
    return this.#invitations.list(scope);
  }

  async revokeInvitation(
    input: Parameters<BusinessInformationStore['revokeInvitation']>[0],
  ): ReturnType<BusinessInformationStore['revokeInvitation']> {
    return this.#invitations.revoke(input);
  }

  async claimInvitation(
    input: Parameters<BusinessInformationStore['claimInvitation']>[0],
  ): ReturnType<BusinessInformationStore['claimInvitation']> {
    return this.#invitations.claim(input);
  }

  async createRequest(
    input: Parameters<BusinessInformationStore['createRequest']>[0],
  ): Promise<RequestCreateResult> {
    const idempotencyKey = idempotencyDigest(input.idempotencyKey);
    const key = `${scopeKey(input.scope)}\0${input.collectionKey}\0${idempotencyKey}`;
    return this.#locks.run(`request-create:${key}`, async () => {
      return this.#locks.run(`intake:${scopeKey(input.scope)}`, async () => {
        const installation = await this.#requiredInstallation(input.scope);
        validateCollectionEnabled(installation, input.collectionKey);
        const candidate = initialRecord({
          installation,
          collectionKey: input.collectionKey,
          id: this.#id(),
          payload: input.payload,
          ...(input.publicInput === undefined ? {} : { publicInput: input.publicInput }),
          origin: input.origin,
          actorSubject: input.actorSubject,
          now: this.#now(),
        });
        const fingerprint = requestFingerprint({
          collectionKey: candidate.collectionKey,
          payload: input.payload,
          origin: candidate.origin,
          actorSubject: candidate.createdBySubject,
        });
        const replay = this.#idempotency.get(key);
        if (replay !== undefined) {
          const existing = this.#expireRecordIfNeeded(replay.recordKey, this.#now());
          if (existing === undefined)
            throw new Error('idempotency record points to a missing request');
          validateStoredRecord(installation, existing);
          return {
            disposition: replay.fingerprint === fingerprint ? 'replayed' : 'conflict',
            record: cloneRecord(existing),
          };
        }
        if (
          !(await this.#lifecycle.applicationAllows(installation)) ||
          ((input.origin.kind === 'embedded' || input.publicInput === true) &&
            !installation.intakeActive)
        ) {
          return { disposition: 'paused' };
        }
        const currentKey = recordKey(input.scope, candidate.collectionKey, candidate.id);
        this.#commitRecord(currentKey, candidate, 'created');
        this.#idempotency.set(key, { fingerprint, recordKey: currentKey });
        return { disposition: 'created', record: cloneRecord(candidate) };
      });
    });
  }

  async probeRequest(
    input: Parameters<BusinessInformationStore['probeRequest']>[0],
  ): ReturnType<BusinessInformationStore['probeRequest']> {
    const installation = await this.#requiredInstallation(input.scope);
    const candidate = initialRecord({
      installation,
      collectionKey: input.collectionKey,
      id: this.#id(),
      payload: input.payload,
      ...(input.publicInput === undefined ? {} : { publicInput: input.publicInput }),
      origin: input.origin,
      actorSubject: input.actorSubject,
      now: this.#now(),
    });
    const digest = idempotencyDigest(input.idempotencyKey);
    const key = `${scopeKey(input.scope)}\0${input.collectionKey}\0${digest}`;
    const replay = this.#idempotency.get(key);
    if (replay === undefined) return { disposition: 'missing' };
    const existing = this.#expireRecordIfNeeded(replay.recordKey, this.#now());
    if (existing === undefined) throw new Error('idempotency record points to a missing request');
    validateStoredRecord(installation, existing);
    const fingerprint = requestFingerprint({
      collectionKey: candidate.collectionKey,
      payload: input.payload,
      origin: candidate.origin,
      actorSubject: candidate.createdBySubject,
    });
    return {
      disposition: replay.fingerprint === fingerprint ? 'replayed' : 'conflict',
      record: cloneRecord(existing),
    };
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
    const key = recordKey(scope, collection.key, validateScalar('record id', id, 128));
    const record = this.#expireRecordIfNeeded(key, this.#now());
    if (record === undefined || (record.deletedAt !== undefined && options.includeDeleted !== true))
      return undefined;
    validateStoredRecord(installation, record);
    return cloneRecord(record);
  }

  async listAcceptedSchemaInventory(): Promise<readonly AcceptedBusinessInformationSchema[]> {
    const inventory = new Map<string, AcceptedBusinessInformationSchema>();
    for (const record of this.#records.values()) {
      const identity = {
        profileKey: record.profileKey,
        profileVersion: record.profileVersion,
        collectionKey: record.collectionKey,
        schemaVersion: record.schemaVersion,
        schemaDigest: record.schemaDigest,
      };
      inventory.set(JSON.stringify(identity), identity);
      if (record.originalSchema !== undefined) {
        const original = { ...identity, ...record.originalSchema };
        inventory.set(JSON.stringify(original), original);
      }
    }
    return [...inventory.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, identity]) => ({ ...identity }));
  }

  async listRequests(
    input: Parameters<BusinessInformationStore['listRequests']>[0],
  ): Promise<RequestPage> {
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const now = this.#now();
    const plan = await planNativeQuery(input, collection, now, (id) =>
      this.getRequest(input.scope, collection.key, id, { includeDeleted: true }),
    );
    const records = this.#matchingRecords(input.scope, collection.key).filter((record) =>
      matchesNativeQueryMetadata(record, plan, now),
    );
    const result = await runNativeQuery(plan, records);
    for (const record of result.records) validateStoredRecord(installation, record);
    return result;
  }

  async mutateRequest(
    input: Parameters<BusinessInformationStore['mutateRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const key = recordKey(input.scope, collection.key, validateScalar('record id', input.id, 128));
    const mutate = () =>
      this.#locks.run<RequestMutationResult>(`request:${key}`, async () => {
        const current = this.#expireRecordIfNeeded(key, this.#now());
        if (current === undefined || current.deletedAt !== undefined) {
          return { ok: false, reason: 'not_found', currentRevision: 0 };
        }
        if (current.revision !== input.expectedRevision) {
          return { ok: false, reason: 'conflict', currentRevision: current.revision };
        }
        if (
          input.operation.kind === 'assign' &&
          !collectionControlEnabled(collection, 'assignment')
        ) {
          return { ok: false, reason: 'invalid_transition', currentRevision: current.revision };
        }
        if (input.operation.kind === 'assign' && input.operation.assigneeSubject !== undefined) {
          const assignee = this.#grants.get(grantKey(input.scope, input.operation.assigneeSubject));
          if (
            assignee === undefined ||
            assignee.revokedAt !== undefined ||
            assignee.role === 'viewer' ||
            !(await this.#principals.allows(assignee.subject))
          ) {
            return { ok: false, reason: 'invalid_assignee', currentRevision: current.revision };
          }
        }
        const historicalCollection = validateStoredRecord(installation, current);
        const applied = applyRequestOperation(
          current,
          {
            ...historicalCollection,
            ...(collection.management === undefined ? {} : { management: collection.management }),
            ...(collection.editableFields === undefined
              ? {}
              : { editableFields: collection.editableFields }),
          },
          input.operation,
          input.actorSubject,
          this.#now(),
          this.#id,
        );
        if (applied === undefined) {
          return { ok: false, reason: 'invalid_transition', currentRevision: current.revision };
        }
        this.#commitRecord(key, applied.record, applied.activityKind);
        return { ok: true, record: cloneRecord(applied.record) };
      });
    return input.operation.kind === 'assign'
      ? this.#locks.run(`grants:${scopeKey(input.scope)}`, mutate)
      : mutate();
  }

  async migrateLegacyRequest(
    input: Parameters<BusinessInformationStore['migrateLegacyRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    validateCollectionEnabled(installation, input.collectionKey);
    const key = recordKey(
      input.scope,
      input.collectionKey,
      validateScalar('record id', input.id, 128),
    );
    return this.#locks.run(`request:${key}`, async () => {
      const current = this.#expireRecordIfNeeded(key, this.#now());
      if (current === undefined || current.deletedAt !== undefined)
        return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
      if (current.revision !== input.expectedRevision)
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      const previous = validateStoredRecord(installation, current);
      const migrated = migrateLegacyRequestRecord(
        current,
        previous,
        installation,
        input.actorSubject,
        this.#now(),
      );
      if (migrated === undefined)
        return { ok: false, reason: 'invalid_transition', currentRevision: current.revision };
      if (migrated !== current) {
        this.#commitRecord(key, migrated, 'schema_migrated');
      }
      return { ok: true, record: cloneRecord(migrated) };
    });
  }

  async deleteRequest(
    input: Parameters<BusinessInformationStore['deleteRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const key = recordKey(input.scope, collection.key, validateScalar('record id', input.id, 128));
    return this.#locks.run(`request:${key}`, () =>
      Promise.resolve(
        this.#eraseRecord(key, input.expectedRevision, input.actorSubject, 'customer_request'),
      ),
    );
  }

  async listActivity(
    scope: InstallationScope,
    collectionKey: string,
    id: string,
    input?: Parameters<BusinessInformationStore['listActivity']>[3],
  ): ReturnType<BusinessInformationStore['listActivity']> {
    const installation = await this.#requiredInstallation(scope);
    const collection = validateCollectionEnabled(installation, collectionKey);
    const key = recordKey(
      validateScope(scope),
      collection.key,
      validateScalar('record id', id, 128),
    );
    const record = this.#expireRecordIfNeeded(key, this.#now());
    if (record !== undefined) validateStoredRecord(installation, record);
    return memoryActivityPage(scope, collection.key, id, this.#activities.get(key) ?? [], input);
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
    for (const record of records) validateStoredRecord(installation, record);
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
      const result = await this.#locks.run(`request:${key}`, () =>
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
    const now = this.#now().toISOString();
    return [...this.#records.entries()]
      .filter(
        ([key, record]) =>
          key.startsWith(prefix) &&
          (record.deletedAt !== undefined || record.retentionExpiresAt > now),
      )
      .map(([, record]) => record)
      .sort(compareRecords);
  }

  #expireRecordIfNeeded(key: string, now: Date): ManagedRequestRecord | undefined {
    const current = this.#records.get(key);
    if (
      current === undefined ||
      current.deletedAt !== undefined ||
      current.retentionExpiresAt > now.toISOString()
    ) {
      return current;
    }
    const erased = deletedRecord(current, 'system:retention', now, 'retention_expired');
    this.#commitRecord(key, erased, 'retention_expired');
    return erased;
  }

  #eraseRecord(
    key: string,
    expectedRevision: number,
    actorSubject: string,
    reason: 'customer_request' | 'retention_expired',
  ): RequestMutationResult {
    const current =
      reason === 'retention_expired'
        ? this.#records.get(key)
        : this.#expireRecordIfNeeded(key, this.#now());
    if (current === undefined || current.deletedAt !== undefined) {
      return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
    }
    if (current.revision !== expectedRevision) {
      return { ok: false, reason: 'conflict', currentRevision: current.revision };
    }
    const erased = deletedRecord(current, actorSubject, this.#now(), reason);
    this.#commitRecord(
      key,
      erased,
      reason === 'customer_request' ? 'deleted' : 'retention_expired',
    );
    return { ok: true, record: cloneRecord(erased) };
  }

  #commitRecord(
    key: string,
    record: ManagedRequestRecord,
    kind: ManagedRequestActivity['kind'],
  ): void {
    commitNativeMemoryRecord(
      this.#records,
      this.#activities,
      this.#custody,
      key,
      record,
      activityFromRecord(record, kind),
    );
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
}

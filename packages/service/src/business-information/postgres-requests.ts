import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sealActivityContent, sealRecordContent } from './cipher.js';
import type {
  ManagedRequestActivity,
  ManagedRequestRecord,
  ManagedRequestStore,
  PayloadCipher,
  RequestCreateResult,
  RequestExportPage,
  RequestMutationResult,
  RequestPage,
  SolutionInstallationStore,
} from './contracts.js';
import {
  activityFromRecord,
  applyRequestOperation,
  deletedRecord,
  idempotencyDigest,
  initialRecord,
  requestFingerprint,
  validateCollectionEnabled,
  validateExpectedRevision,
} from './model.js';
import { decodeCursor, encodeCursor, scopeKey } from './pagination.js';
import {
  type ActivityRow,
  activityFromRow,
  type RequestRow,
  requestFromRow,
} from './postgres-rows.js';
import { inTransaction } from './postgres-transaction.js';
import {
  boundedExportPageSize,
  boundedPageSize,
  validateScalar,
  validateScope,
} from './validation.js';

export interface PostgresManagedRequestStoreOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

export class PostgresManagedRequestStore implements ManagedRequestStore {
  readonly #pool: Pool;
  readonly #cipher: PayloadCipher;
  readonly #installations: SolutionInstallationStore;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(
    pool: Pool,
    cipher: PayloadCipher,
    installations: SolutionInstallationStore,
    options: PostgresManagedRequestStoreOptions = {},
  ) {
    this.#pool = pool;
    this.#cipher = cipher;
    this.#installations = installations;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
  }

  async createRequest(
    input: Parameters<ManagedRequestStore['createRequest']>[0],
  ): Promise<RequestCreateResult> {
    const installation = await this.#requiredInstallation(input.scope);
    validateCollectionEnabled(installation, input.collectionKey);
    const digest = idempotencyDigest(input.idempotencyKey);
    const candidate = initialRecord({
      installation,
      collectionKey: input.collectionKey,
      id: this.#id(),
      payload: input.payload,
      origin: input.origin,
      actorSubject: input.actorSubject,
      now: this.#now(),
    });
    const candidateFingerprint = fingerprint(candidate);
    return inTransaction(this.#pool, async (client) => {
      const existing = await this.#findByIdempotency(client, candidate, digest);
      if (existing !== undefined) {
        return {
          disposition:
            existing.createFingerprint === candidateFingerprint ? 'replayed' : 'conflict',
          record: existing.record,
        };
      }
      const sealed = await this.#sealRecord(candidate);
      const inserted = await client.query<RequestRow>(
        `INSERT INTO managed_request_records
          (org_slug, app_slug, environment, installation_id, collection_key, record_id,
           profile_key, profile_version, schema_version, schema_digest, status, assignee_subject,
           origin_kind, revision, retention_expires_at, created_at, created_by_subject,
           updated_at, updated_by_subject, deleted_at, deletion_reason, content_ciphertext,
           idempotency_digest, create_fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NULL,NULL,$20::jsonb,$21,$22)
         ON CONFLICT (org_slug, app_slug, environment, installation_id, collection_key, idempotency_digest)
         DO NOTHING RETURNING *`,
        [
          candidate.scope.org,
          candidate.scope.app,
          candidate.scope.env,
          candidate.scope.installationId,
          candidate.collectionKey,
          candidate.id,
          candidate.profileKey,
          candidate.profileVersion,
          candidate.schemaVersion,
          candidate.schemaDigest,
          candidate.status,
          candidate.assigneeSubject ?? null,
          candidate.origin.kind,
          candidate.revision,
          candidate.retentionExpiresAt,
          candidate.createdAt,
          candidate.createdBySubject,
          candidate.updatedAt,
          candidate.updatedBySubject,
          JSON.stringify(sealed),
          digest,
          candidateFingerprint,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        const raced = await this.#findByIdempotency(client, candidate, digest);
        if (raced === undefined) throw new Error('idempotent request insert returned no record');
        return {
          disposition: raced.createFingerprint === candidateFingerprint ? 'replayed' : 'conflict',
          record: raced.record,
        };
      }
      await this.#insertActivity(client, activityFromRecord(candidate, 'created'));
      return { disposition: 'created', record: await requestFromRow(insertedRow, this.#cipher) };
    });
  }

  async getRequest(
    scope: Parameters<ManagedRequestStore['getRequest']>[0],
    collectionKey: string,
    id: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<ManagedRequestRecord | undefined> {
    const installation = await this.#requiredInstallation(scope);
    const collection = validateCollectionEnabled(installation, collectionKey);
    const result = await this.#pool.query<RequestRow>(
      `SELECT * FROM managed_request_records
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6
         ${options.includeDeleted === true ? '' : 'AND deleted_at IS NULL'}`,
      [
        scope.org,
        scope.app,
        scope.env,
        scope.installationId,
        collection.key,
        validateScalar('record id', id, 128),
      ],
    );
    return result.rows[0] === undefined ? undefined : requestFromRow(result.rows[0], this.#cipher);
  }

  async listRequests(
    input: Parameters<ManagedRequestStore['listRequests']>[0],
  ): Promise<RequestPage> {
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeCursor(input.cursor, {
            kind: 'list',
            scope: input.scope,
            collectionKey: collection.key,
          });
    const { rows, limit } = await this.#queryPage({
      ...input,
      collectionKey: collection.key,
      ...(cursor === undefined
        ? {}
        : { lastCreatedAt: cursor.lastCreatedAt, lastId: cursor.lastId }),
    });
    const records = await Promise.all(
      rows.slice(0, limit).map((row) => requestFromRow(row, this.#cipher)),
    );
    return this.#page(records, rows.length > limit, 'list', input.scope, collection.key);
  }

  async mutateRequest(
    input: Parameters<ManagedRequestStore['mutateRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    return inTransaction(this.#pool, async (client) => {
      const current = await this.#lockedRecord(client, input.scope, collection.key, input.id);
      if (current === undefined || current.deletedAt !== undefined) {
        return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
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
      await this.#updateCurrent(client, applied.record, input.expectedRevision);
      await this.#insertActivity(client, activityFromRecord(applied.record, applied.activityKind));
      return { ok: true, record: applied.record };
    });
  }

  async deleteRequest(
    input: Parameters<ManagedRequestStore['deleteRequest']>[0],
  ): Promise<RequestMutationResult> {
    validateExpectedRevision(input.expectedRevision);
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
    return inTransaction(this.#pool, async (client) => {
      const current = await this.#lockedRecord(client, input.scope, collection.key, input.id);
      if (current === undefined || current.deletedAt !== undefined) {
        return { ok: false, reason: 'not_found', currentRevision: current?.revision ?? 0 };
      }
      if (current.revision !== input.expectedRevision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision };
      }
      const erased = deletedRecord(current, input.actorSubject, this.#now(), 'customer_request');
      await this.#eraseCurrent(client, erased, input.expectedRevision);
      await this.#insertActivity(client, activityFromRecord(erased, 'deleted'));
      return { ok: true, record: erased };
    });
  }

  async listActivity(
    scope: Parameters<ManagedRequestStore['listActivity']>[0],
    collectionKey: string,
    id: string,
  ): Promise<readonly ManagedRequestActivity[]> {
    const installation = await this.#requiredInstallation(scope);
    const collection = validateCollectionEnabled(installation, collectionKey);
    const result = await this.#pool.query<ActivityRow>(
      `SELECT * FROM managed_request_activities
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6 ORDER BY revision`,
      [
        scope.org,
        scope.app,
        scope.env,
        scope.installationId,
        collection.key,
        validateScalar('record id', id, 128),
      ],
    );
    return Promise.all(result.rows.map((row) => activityFromRow(row, this.#cipher)));
  }

  async exportRequests(
    input: Parameters<ManagedRequestStore['exportRequests']>[0],
  ): Promise<RequestExportPage> {
    const installation = await this.#requiredInstallation(input.scope);
    const collection = validateCollectionEnabled(installation, input.collectionKey);
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
    const { rows, limit } = await this.#queryPage({
      ...input,
      collectionKey: collection.key,
      snapshotAt,
      exportPage: true,
      ...(cursor === undefined
        ? {}
        : { lastCreatedAt: cursor.lastCreatedAt, lastId: cursor.lastId }),
    });
    const records = await Promise.all(
      rows.slice(0, limit).map((row) => requestFromRow(row, this.#cipher)),
    );
    return {
      ...this.#page(
        records,
        rows.length > limit,
        'export',
        input.scope,
        collection.key,
        snapshotAt,
      ),
      snapshotAt,
    };
  }

  async purgeExpired(input: Parameters<ManagedRequestStore['purgeExpired']>[0]): Promise<number> {
    const limit = boundedPageSize(input.limit);
    if (input.scope !== undefined) validateScope(input.scope);
    return inTransaction(this.#pool, async (client) => {
      const values: unknown[] = [this.#now(), limit];
      const scopeClause =
        input.scope === undefined
          ? ''
          : `AND org_slug=$3 AND app_slug=$4 AND environment=$5 AND installation_id=$6`;
      if (input.scope !== undefined) {
        values.push(input.scope.org, input.scope.app, input.scope.env, input.scope.installationId);
      }
      const candidates = await client.query<RequestRow>(
        `SELECT * FROM managed_request_records
         WHERE deleted_at IS NULL AND retention_expires_at <= $1 ${scopeClause}
         ORDER BY retention_expires_at, record_id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        values,
      );
      for (const row of candidates.rows) {
        const current = await requestFromRow(row, this.#cipher);
        const erased = deletedRecord(current, 'system:retention', this.#now(), 'retention_expired');
        await this.#eraseCurrent(client, erased, current.revision);
        await this.#insertActivity(client, activityFromRecord(erased, 'retention_expired'));
      }
      return candidates.rows.length;
    });
  }

  async #queryPage(input: {
    readonly scope: ManagedRequestRecord['scope'];
    readonly collectionKey: string;
    readonly status?: ManagedRequestRecord['status'];
    readonly assigneeSubject?: string;
    readonly includeDeleted?: boolean;
    readonly lastCreatedAt?: string;
    readonly lastId?: string;
    readonly snapshotAt?: string;
    readonly limit?: number;
    readonly exportPage?: boolean;
  }): Promise<{ rows: readonly RequestRow[]; limit: number }> {
    const limit = input.exportPage
      ? boundedExportPageSize(input.limit)
      : boundedPageSize(input.limit);
    const values: unknown[] = [
      input.scope.org,
      input.scope.app,
      input.scope.env,
      input.scope.installationId,
      input.collectionKey,
    ];
    const clauses = [
      'org_slug=$1',
      'app_slug=$2',
      'environment=$3',
      'installation_id=$4',
      'collection_key=$5',
    ];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (input.includeDeleted !== true) clauses.push('deleted_at IS NULL');
    if (input.status !== undefined) add('status=?', input.status);
    if (input.assigneeSubject !== undefined) add('assignee_subject=?', input.assigneeSubject);
    if (input.lastCreatedAt !== undefined && input.lastId !== undefined) {
      values.push(input.lastCreatedAt, input.lastId);
      clauses.push(`(created_at, record_id) > ($${values.length - 1}, $${values.length})`);
    }
    if (input.snapshotAt !== undefined) add('created_at<=?', input.snapshotAt);
    values.push(limit + 1);
    const result = await this.#pool.query<RequestRow>(
      `SELECT * FROM managed_request_records WHERE ${clauses.join(' AND ')}
       ORDER BY created_at, record_id LIMIT $${values.length}`,
      values,
    );
    return { rows: result.rows, limit };
  }

  async #findByIdempotency(
    client: PoolClient,
    candidate: ManagedRequestRecord,
    digest: string,
  ): Promise<
    { readonly record: ManagedRequestRecord; readonly createFingerprint: string } | undefined
  > {
    const result = await client.query<RequestRow>(
      `SELECT * FROM managed_request_records
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND idempotency_digest=$6 FOR UPDATE`,
      [
        candidate.scope.org,
        candidate.scope.app,
        candidate.scope.env,
        candidate.scope.installationId,
        candidate.collectionKey,
        digest,
      ],
    );
    const row = result.rows[0];
    return row === undefined
      ? undefined
      : {
          record: await requestFromRow(row, this.#cipher),
          createFingerprint: row.create_fingerprint,
        };
  }

  async #lockedRecord(
    client: PoolClient,
    scope: ManagedRequestRecord['scope'],
    collectionKey: string,
    id: string,
  ): Promise<ManagedRequestRecord | undefined> {
    const result = await client.query<RequestRow>(
      `SELECT * FROM managed_request_records
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6 FOR UPDATE`,
      [
        scope.org,
        scope.app,
        scope.env,
        scope.installationId,
        collectionKey,
        validateScalar('record id', id, 128),
      ],
    );
    return result.rows[0] === undefined ? undefined : requestFromRow(result.rows[0], this.#cipher);
  }

  async #updateCurrent(
    client: PoolClient,
    record: ManagedRequestRecord,
    expectedRevision: number,
  ): Promise<void> {
    const sealed = await this.#sealRecord(record);
    const result = await client.query(
      `UPDATE managed_request_records SET
         status=$7, assignee_subject=$8, revision=$9, updated_at=$10,
         updated_by_subject=$11, content_ciphertext=$12::jsonb
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6 AND revision=$13 AND deleted_at IS NULL`,
      [
        record.scope.org,
        record.scope.app,
        record.scope.env,
        record.scope.installationId,
        record.collectionKey,
        record.id,
        record.status,
        record.assigneeSubject ?? null,
        record.revision,
        record.updatedAt,
        record.updatedBySubject,
        JSON.stringify(sealed),
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) throw new Error('managed request CAS changed during transaction');
  }

  async #eraseCurrent(
    client: PoolClient,
    record: ManagedRequestRecord,
    expectedRevision: number,
  ): Promise<void> {
    const result = await client.query(
      `UPDATE managed_request_records SET
         revision=$7, updated_at=$8, updated_by_subject=$9, deleted_at=$10,
         deletion_reason=$11, content_ciphertext=NULL
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6 AND revision=$12 AND deleted_at IS NULL`,
      [
        record.scope.org,
        record.scope.app,
        record.scope.env,
        record.scope.installationId,
        record.collectionKey,
        record.id,
        record.revision,
        record.updatedAt,
        record.updatedBySubject,
        record.deletedAt,
        record.deletionReason,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) throw new Error('managed request CAS changed during erase');
    await client.query(
      `UPDATE managed_request_activities SET content_ciphertext=NULL
       WHERE org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4
         AND collection_key=$5 AND record_id=$6`,
      [
        record.scope.org,
        record.scope.app,
        record.scope.env,
        record.scope.installationId,
        record.collectionKey,
        record.id,
      ],
    );
  }

  async #insertActivity(client: PoolClient, activity: ManagedRequestActivity): Promise<void> {
    const sealed =
      activity.content === undefined
        ? undefined
        : await sealActivityContent(
            this.#cipher,
            {
              ...activity.scope,
              collectionKey: activity.collectionKey,
              recordId: activity.recordId,
              revision: activity.revision,
            },
            activity.content,
          );
    await client.query(
      `INSERT INTO managed_request_activities
        (org_slug, app_slug, environment, installation_id, collection_key, record_id,
         revision, kind, status, assignee_subject, occurred_at, actor_subject, content_ciphertext)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [
        activity.scope.org,
        activity.scope.app,
        activity.scope.env,
        activity.scope.installationId,
        activity.collectionKey,
        activity.recordId,
        activity.revision,
        activity.kind,
        activity.status,
        activity.assigneeSubject ?? null,
        activity.occurredAt,
        activity.actorSubject,
        sealed === undefined ? null : JSON.stringify(sealed),
      ],
    );
  }

  #sealRecord(record: ManagedRequestRecord) {
    if (record.content === undefined) throw new Error('cannot seal an erased managed request');
    return sealRecordContent(
      this.#cipher,
      {
        ...record.scope,
        collectionKey: record.collectionKey,
        recordId: record.id,
        revision: record.revision,
      },
      record.content,
      record.origin,
    );
  }

  #page(
    records: readonly ManagedRequestRecord[],
    hasMore: boolean,
    kind: 'list' | 'export',
    scope: ManagedRequestRecord['scope'],
    collectionKey: string,
    snapshotAt?: string,
  ): RequestPage {
    const last = records.at(-1);
    return {
      records,
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

  async #requiredInstallation(scope: ManagedRequestRecord['scope']) {
    const installation = await this.#installations.getInstallation(validateScope(scope));
    if (installation === undefined) throw new Error('solution installation was not found');
    return installation;
  }
}

function fingerprint(record: ManagedRequestRecord): string {
  return requestFingerprint({
    collectionKey: record.collectionKey,
    payload: record.content?.payload,
    origin: record.origin,
    actorSubject: record.createdBySubject,
  });
}

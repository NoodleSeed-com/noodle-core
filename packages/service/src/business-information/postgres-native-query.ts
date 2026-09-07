import type { Pool } from 'pg';
import type { ManagedRequestRecord, PayloadCipher, SolutionInstallation } from './contracts.js';
import { validateStoredRecord } from './model.js';
import {
  type NativeListInput,
  type NativeQueryPlan,
  planNativeQuery,
  runNativeQuery,
} from './native-query.js';
import { type RequestRow, requestFromRow } from './postgres-rows.js';

export async function listPostgresNativeRecords(
  input: NativeListInput,
  dependencies: {
    readonly pool: Pool;
    readonly cipher: PayloadCipher;
    readonly installation: SolutionInstallation;
    readonly now: Date;
    readonly loadAnchor: (id: string) => Promise<ManagedRequestRecord | undefined>;
  },
) {
  const collection = dependencies.installation.definition.collections.find(
    (entry) => entry.key === input.collectionKey,
  );
  if (collection === undefined) throw new Error('collection is not installed');
  const plan = await planNativeQuery(input, collection, dependencies.now, dependencies.loadAnchor);
  return runNativeQuery(plan, scanRecords(plan, dependencies));
}

async function* scanRecords(
  plan: NativeQueryPlan,
  dependencies: {
    readonly pool: Pool;
    readonly cipher: PayloadCipher;
    readonly installation: SolutionInstallation;
    readonly now: Date;
  },
): AsyncGenerator<ManagedRequestRecord> {
  const input = plan.input;
  let after = plan.payloadQuery ? undefined : plan.anchor;
  const batchSize = plan.payloadQuery ? 200 : plan.limit + 1;
  for (;;) {
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
    const add = (sql: string, value: unknown) => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (input.includeDeleted !== true) clauses.push('deleted_at IS NULL');
    add(
      input.includeDeleted === true
        ? '(deleted_at IS NOT NULL OR retention_expires_at>?)'
        : 'retention_expires_at>?',
      dependencies.now.toISOString(),
    );
    if (input.status !== undefined) add('status=?', input.status);
    if (input.assigneeSubject !== undefined) add('assignee_subject=?', input.assigneeSubject);
    if (input.createdAtFrom !== undefined) add('created_at>=?', input.createdAtFrom);
    if (input.createdAtTo !== undefined) add('created_at<=?', input.createdAtTo);
    add('created_at<=?', plan.snapshotAt);
    if (after !== undefined) {
      values.push(after.createdAt, after.id);
      clauses.push(`(created_at, record_id) > ($${values.length - 1}, $${values.length})`);
    }
    values.push(batchSize);
    const result = await dependencies.pool.query<RequestRow>(
      `SELECT * FROM managed_request_records WHERE ${clauses.join(' AND ')} ORDER BY created_at, record_id LIMIT $${values.length}`,
      values,
    );
    for (const row of result.rows) {
      const record = await requestFromRow(row, dependencies.cipher);
      validateStoredRecord(dependencies.installation, record);
      after = record;
      yield record;
    }
    if (result.rows.length < batchSize) return;
  }
}

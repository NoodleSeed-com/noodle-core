import { createHash } from 'node:crypto';
import { canonicalJson, validateJsonSchema } from '@noodle-borg/compiler';
import {
  MANAGED_RECORD_QUERY_SCAN_LIMIT,
  ManagedRecordQuerySchema,
} from '@noodle-borg/wire-contracts';
import type {
  InstalledCollectionDefinition,
  ManagedRequestRecord,
  ManagedRequestStore,
  RequestPage,
} from './contracts.js';
import { cloneRecord } from './model.js';
import { compareRecords, scopeKey } from './pagination.js';
import { boundedPageSize, CursorValidationError } from './validation.js';

export type NativeListInput = Parameters<ManagedRequestStore['listRequests']>[0];
export class NativeQueryError extends Error {
  constructor(
    readonly code: 'invalid_query' | 'query_limit_exceeded',
    message: string,
  ) {
    super(message);
  }
}
interface QueryCursor {
  readonly version: 2;
  readonly digest: string;
  readonly snapshotAt: string;
  readonly lastId: string;
  readonly lastRevision: number;
}
export interface NativeQueryPlan {
  readonly input: NativeListInput;
  readonly limit: number;
  readonly payloadQuery: boolean;
  readonly snapshotAt: string;
  readonly digest: string;
  readonly anchor?: ManagedRequestRecord;
}

export async function planNativeQuery(
  input: NativeListInput,
  collection: InstalledCollectionDefinition,
  now: Date,
  loadAnchor: (id: string) => Promise<ManagedRequestRecord | undefined>,
): Promise<NativeQueryPlan> {
  const parsed = ManagedRecordQuerySchema.safeParse({
    ...(input.filters === undefined ? {} : { filters: input.filters }),
    ...(input.sortField === undefined ? {} : { sortField: input.sortField }),
    ...(input.sortDirection === undefined ? {} : { sortDirection: input.sortDirection }),
    ...(input.createdAtFrom === undefined ? {} : { createdAtFrom: input.createdAtFrom }),
    ...(input.createdAtTo === undefined ? {} : { createdAtTo: input.createdAtTo }),
  });
  if (!parsed.success)
    throw new NativeQueryError('invalid_query', 'Invalid bounded collection query.');
  const properties = collection.recordSchema.properties as Record<string, unknown> | undefined;
  for (const filter of parsed.data.filters ?? []) {
    if (!collection.filterFields?.includes(filter.field))
      throw new NativeQueryError('invalid_query', 'Filter field must be declared in filterFields.');
    if (
      validateJsonSchema(properties?.[filter.field] as Record<string, unknown>, filter.value)
        .length > 0
    )
      throw new NativeQueryError('invalid_query', 'Filter value must match its field schema.');
  }
  if (input.sortField !== undefined && !collection.sortFields?.includes(input.sortField))
    throw new NativeQueryError('invalid_query', 'Sort field must be declared in sortFields.');
  const normalized = {
    ...input,
    filters: [...(parsed.data.filters ?? [])].sort((a, b) => a.field.localeCompare(b.field)),
    ...(input.sortField === undefined
      ? {}
      : { sortDirection: input.sortDirection ?? ('asc' as const) }),
    ...(input.createdAtFrom === undefined
      ? {}
      : { createdAtFrom: new Date(input.createdAtFrom).toISOString() }),
    ...(input.createdAtTo === undefined
      ? {}
      : { createdAtTo: new Date(input.createdAtTo).toISOString() }),
  };
  const limit = boundedPageSize(input.limit);
  const digest = createHash('sha256')
    .update(
      canonicalJson({
        scope: scopeKey(input.scope),
        collection: collection.key,
        schema: collection.schemaDigest,
        filters: normalized.filters,
        sortField: input.sortField ?? null,
        sortDirection: normalized.sortDirection ?? null,
        createdAtFrom: normalized.createdAtFrom ?? null,
        createdAtTo: normalized.createdAtTo ?? null,
        status: input.status ?? null,
        assigneeSubject: input.assigneeSubject ?? null,
        includeDeleted: input.includeDeleted === true,
      }),
    )
    .digest('hex');
  const cursor =
    input.cursor === undefined ? undefined : readQueryCursor(input.cursor, digest, now);
  const anchor = cursor === undefined ? undefined : await loadAnchor(cursor.lastId);
  if (cursor !== undefined && (anchor === undefined || anchor.revision !== cursor.lastRevision))
    throw new CursorValidationError('cursor anchor changed or was deleted; restart this query');
  return {
    input: normalized,
    limit,
    digest,
    payloadQuery: normalized.filters.length > 0 || input.sortField !== undefined,
    snapshotAt: cursor?.snapshotAt ?? now.toISOString(),
    ...(anchor === undefined ? {} : { anchor }),
  };
}

function readQueryCursor(encoded: string, digest: string, now: Date): QueryCursor {
  try {
    if (encoded.length > 2048) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (value === null || typeof value !== 'object') throw new Error();
    const cursor = value as Partial<QueryCursor>;
    if (
      cursor.version !== 2 ||
      cursor.digest !== digest ||
      typeof cursor.lastId !== 'string' ||
      cursor.lastId.length > 128 ||
      typeof cursor.lastRevision !== 'number' ||
      !Number.isSafeInteger(cursor.lastRevision) ||
      cursor.lastRevision < 1 ||
      typeof cursor.snapshotAt !== 'string' ||
      !Number.isFinite(Date.parse(cursor.snapshotAt)) ||
      Date.parse(cursor.snapshotAt) > now.getTime()
    )
      throw new Error();
    return cursor as QueryCursor;
  } catch {
    throw new CursorValidationError('cursor does not belong to this query and schema');
  }
}

export function matchesNativeQueryMetadata(
  record: ManagedRequestRecord,
  plan: NativeQueryPlan,
  now: Date,
): boolean {
  const input = plan.input;
  return (
    scopeKey(record.scope) === scopeKey(input.scope) &&
    record.collectionKey === input.collectionKey &&
    (input.includeDeleted === true || record.deletedAt === undefined) &&
    (record.deletedAt !== undefined || record.retentionExpiresAt > now.toISOString()) &&
    (input.status === undefined || record.status === input.status) &&
    (input.assigneeSubject === undefined || record.assigneeSubject === input.assigneeSubject) &&
    record.createdAt <= plan.snapshotAt &&
    (input.createdAtFrom === undefined || record.createdAt >= input.createdAtFrom) &&
    (input.createdAtTo === undefined || record.createdAt <= input.createdAtTo)
  );
}

/** Source is already scoped/date filtered and createdAt/id ordered; retains only page + one candidates. */
export async function runNativeQuery(
  plan: NativeQueryPlan,
  source: AsyncIterable<ManagedRequestRecord> | Iterable<ManagedRequestRecord>,
): Promise<RequestPage> {
  const selected: ManagedRequestRecord[] = [];
  let scanned = 0;
  for await (const record of source) {
    if (plan.payloadQuery && ++scanned > MANAGED_RECORD_QUERY_SCAN_LIMIT)
      throw new NativeQueryError(
        'query_limit_exceeded',
        'This query exceeds 10,000 scanned records. Narrow createdAtFrom/createdAtTo and retry.',
      );
    if (
      !plan.input.filters?.every((filter) => record.content?.payload[filter.field] === filter.value)
    )
      continue;
    if (plan.anchor !== undefined && compareQueryRecords(record, plan.anchor, plan) <= 0) continue;
    selected.push(record);
    selected.sort((a, b) => compareQueryRecords(a, b, plan));
    if (selected.length > plan.limit + 1) selected.pop();
    if (!plan.payloadQuery && selected.length > plan.limit) break;
  }
  const records = selected.slice(0, plan.limit).map(cloneRecord);
  const last = records.at(-1);
  return {
    records,
    ...(selected.length > plan.limit && last !== undefined
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              version: 2,
              digest: plan.digest,
              snapshotAt: plan.snapshotAt,
              lastId: last.id,
              lastRevision: last.revision,
            } satisfies QueryCursor),
          ).toString('base64url'),
        }
      : {}),
  };
}

function compareQueryRecords(
  a: ManagedRequestRecord,
  b: ManagedRequestRecord,
  plan: NativeQueryPlan,
): number {
  const field = plan.input.sortField;
  if (field === undefined) return compareRecords(a, b);
  const left = a.content?.payload[field];
  const right = b.content?.payload[field];
  // Missing historical/optional fields sort last in both directions.
  if (left === undefined || left === null)
    return right === undefined || right === null ? compareRecords(a, b) : 1;
  if (right === undefined || right === null) return -1;
  const compared = left === right ? 0 : left < right ? -1 : 1;
  return (plan.input.sortDirection === 'desc' ? -compared : compared) || compareRecords(a, b);
}

import type {
  InstallationScope,
  ManagedRequestActivity,
  RequestActivityPage,
} from './contracts.js';
import { cloneActivity } from './model.js';
import { scopeKey } from './pagination.js';
import { boundedPageSize, CursorValidationError, validateScalar } from './validation.js';

export interface ActivityPaging {
  readonly cursor?: string;
  readonly limit?: number;
}
export function activityPaging(
  scope: InstallationScope,
  collection: string,
  record: string,
  input: ActivityPaging = {},
): { limit: number; before?: number } {
  const limit = boundedPageSize(input.limit);
  if (input.cursor === undefined) return { limit };
  try {
    const value: unknown = JSON.parse(
      Buffer.from(validateScalar('cursor', input.cursor, 2048), 'base64url').toString('utf8'),
    );
    if (
      typeof value !== 'object' ||
      value === null ||
      !('version' in value) ||
      value.version !== 1 ||
      !('kind' in value) ||
      value.kind !== 'record-activity' ||
      !('scope' in value) ||
      value.scope !== scopeKey(scope) ||
      !('collection' in value) ||
      value.collection !== collection ||
      !('record' in value) ||
      value.record !== record ||
      !('before' in value) ||
      typeof value.before !== 'number' ||
      !Number.isSafeInteger(value.before) ||
      value.before < 1
    )
      throw new CursorValidationError();
    return { limit, before: value.before };
  } catch {
    throw new CursorValidationError('cursor does not belong to this record history');
  }
}

export function activityPage(
  scope: InstallationScope,
  collection: string,
  record: string,
  rows: readonly ManagedRequestActivity[],
  limit: number,
): RequestActivityPage {
  const activities = rows.slice(0, limit);
  const last = activities.at(-1);
  return {
    activities,
    ...(rows.length > limit && last !== undefined
      ? {
          nextCursor: Buffer.from(
            JSON.stringify({
              version: 1,
              kind: 'record-activity',
              scope: scopeKey(scope),
              collection,
              record,
              before: last.revision,
            }),
          ).toString('base64url'),
        }
      : {}),
  };
}

/** History is append-only in revision order; select a bounded window without copying the full array. */
export function memoryActivityPage(
  scope: InstallationScope,
  collection: string,
  record: string,
  history: readonly ManagedRequestActivity[],
  input?: ActivityPaging,
): RequestActivityPage {
  const paging = activityPaging(scope, collection, record, input);
  let end = history.length;
  if (paging.before !== undefined) {
    let low = 0;
    while (low < end) {
      const middle = Math.floor((low + end) / 2);
      const entry = history[middle];
      if (entry !== undefined && entry.revision < paging.before) low = middle + 1;
      else end = middle;
    }
  }
  const selected = history
    .slice(Math.max(0, end - paging.limit - 1), end)
    .reverse()
    .map(cloneActivity);
  return activityPage(scope, collection, record, selected, paging.limit);
}

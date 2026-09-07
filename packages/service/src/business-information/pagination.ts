import type { InstallationScope, ManagedRequestRecord } from './contracts.js';
import { CursorValidationError, validateScalar } from './validation.js';

interface CursorValue {
  readonly version: 1;
  readonly kind: 'list' | 'export';
  readonly scope: string;
  readonly collectionKey: string;
  readonly lastCreatedAt: string;
  readonly lastId: string;
  readonly snapshotAt?: string;
}

export function scopeKey(scope: InstallationScope): string {
  return `${scope.org}\0${scope.app}\0${scope.env}\0${scope.installationId}`;
}

export function recordKey(scope: InstallationScope, collectionKey: string, id: string): string {
  return `${scopeKey(scope)}\0${collectionKey}\0${id}`;
}

export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string,
  expected: {
    readonly kind: CursorValue['kind'];
    readonly scope: InstallationScope;
    readonly collectionKey: string;
  },
): CursorValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(validateScalar('cursor', cursor, 2048), 'base64url').toString('utf8'),
    );
  } catch {
    throw new CursorValidationError();
  }
  if (!isCursor(parsed)) throw new CursorValidationError();
  if (
    parsed.kind !== expected.kind ||
    parsed.scope !== scopeKey(expected.scope) ||
    parsed.collectionKey !== expected.collectionKey
  ) {
    throw new CursorValidationError('cursor does not belong to this request scope');
  }
  return parsed;
}

export function afterCursor(record: ManagedRequestRecord, cursor: CursorValue): boolean {
  return (
    record.createdAt > cursor.lastCreatedAt ||
    (record.createdAt === cursor.lastCreatedAt && record.id > cursor.lastId)
  );
}

export function compareRecords(left: ManagedRequestRecord, right: ManagedRequestRecord): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function isCursor(value: unknown): value is CursorValue {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Partial<CursorValue>;
  return (
    input.version === 1 &&
    (input.kind === 'list' || input.kind === 'export') &&
    typeof input.scope === 'string' &&
    typeof input.collectionKey === 'string' &&
    validTimestamp(input.lastCreatedAt) &&
    typeof input.lastId === 'string' &&
    (input.snapshotAt === undefined || validTimestamp(input.snapshotAt))
  );
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

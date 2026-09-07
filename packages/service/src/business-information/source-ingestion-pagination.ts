import { scopeKey } from './pagination.js';
import type { SourceBindingKey } from './source-ingestion-contracts.js';
import { sourceDigest, sourceInteger } from './source-ingestion-validation.js';
import { CursorValidationError, validateScalar } from './validation.js';

interface ExternalRecordCursor {
  readonly version: 1;
  readonly kind: 'external-records';
  readonly scope: string;
  readonly collectionKey: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly lastIdentityDigest: string;
}

export function externalRecordPageLimit(value: number | undefined): number {
  return sourceInteger('external record page limit', value ?? 100, 1, 500);
}

export function encodeExternalRecordCursor(
  binding: SourceBindingKey & { readonly generation: number },
  lastIdentityDigest: string,
): string {
  const cursor: ExternalRecordCursor = {
    version: 1,
    kind: 'external-records',
    scope: scopeKey(binding.scope),
    collectionKey: binding.collectionKey,
    bindingId: binding.id,
    bindingGeneration: binding.generation,
    lastIdentityDigest: sourceDigest('source identity digest', lastIdentityDigest),
  };
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeExternalRecordCursor(
  value: string | undefined,
  binding: SourceBindingKey & { readonly generation: number },
): string | undefined {
  if (value === undefined) return undefined;
  try {
    const decoded = JSON.parse(
      Buffer.from(validateScalar('cursor', value, 2_048), 'base64url').toString('utf8'),
    ) as unknown;
    if (!isExternalRecordCursor(decoded)) throw new CursorValidationError();
    if (
      decoded.scope !== scopeKey(binding.scope) ||
      decoded.collectionKey !== binding.collectionKey ||
      decoded.bindingId !== binding.id ||
      decoded.bindingGeneration !== binding.generation
    ) {
      throw new CursorValidationError('cursor does not belong to this source binding');
    }
    return decoded.lastIdentityDigest;
  } catch (error) {
    if (error instanceof CursorValidationError) throw error;
    throw new CursorValidationError();
  }
}

function isExternalRecordCursor(value: unknown): value is ExternalRecordCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const input = value as Partial<ExternalRecordCursor>;
  return (
    input.version === 1 &&
    input.kind === 'external-records' &&
    typeof input.scope === 'string' &&
    typeof input.collectionKey === 'string' &&
    typeof input.bindingId === 'string' &&
    Number.isSafeInteger(input.bindingGeneration) &&
    (input.bindingGeneration ?? 0) > 0 &&
    typeof input.lastIdentityDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(input.lastIdentityDigest)
  );
}

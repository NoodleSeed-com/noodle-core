import type { ServerResponse } from 'node:http';
import { sendJson } from '@noodle-borg/transport-http';
import {
  CursorValidationError,
  type ExternalRecord,
  type InstalledCollectionDefinition,
  type SolutionInstallation,
  type SourceBindingRecord,
} from '../business-information/portable.js';
import type { BusinessInformationRouteDeps } from './business-information.js';
import { externalRecordToWire } from './business-information-wire.js';

export function sourceBindingKey(
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
) {
  return {
    scope: installation.scope,
    collectionKey: collection.key,
    id: collection.key,
  };
}

export async function loadExternalRecords(
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
  deps: BusinessInformationRouteDeps,
  paging: { readonly cursor?: string; readonly limit?: number } = {},
) {
  if (deps.sourceStore === undefined) return undefined;
  const key = sourceBindingKey(installation, collection);
  const binding = await deps.sourceStore.getBinding(key);
  if (binding === undefined) return undefined;
  if (binding.state === 'revoked' || binding.health === 'reauth_required') return undefined;
  const page = await deps.sourceStore.listExternalRecords({
    ...key,
    generation: binding.generation,
    ...paging,
  });
  return { binding, ...page };
}

export async function loadExternalRecord(
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
  recordId: string,
  deps: BusinessInformationRouteDeps,
): Promise<
  { readonly binding: SourceBindingRecord; readonly record: ExternalRecord | undefined } | undefined
> {
  if (deps.sourceStore === undefined) return undefined;
  const key = sourceBindingKey(installation, collection);
  const binding = await deps.sourceStore.getBinding(key);
  if (
    binding === undefined ||
    binding.state === 'revoked' ||
    binding.health === 'reauth_required'
  ) {
    return undefined;
  }
  const record = await deps.sourceStore.getExternalRecord({
    ...key,
    generation: binding.generation,
    recordId,
  });
  return { binding, record };
}

export async function sendExternalRecordPage(
  res: ServerResponse,
  installation: SolutionInstallation,
  collection: InstalledCollectionDefinition,
  paging: { readonly cursor?: string; readonly limit?: number },
  deps: BusinessInformationRouteDeps,
): Promise<void> {
  let loaded: Awaited<ReturnType<typeof loadExternalRecords>>;
  try {
    loaded = await loadExternalRecords(installation, collection, deps, paging);
  } catch (error) {
    if (!(error instanceof CursorValidationError)) throw error;
    sendJson(res, 400, { error: 'cursor is invalid', code: 'invalid_cursor' });
    return;
  }
  if (loaded === undefined) {
    sendJson(res, 503, {
      error: 'collection source is not configured or unavailable',
      code: 'source_unavailable',
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data: {
      records: loaded.records.map((record) => externalRecordToWire(record, loaded.binding)),
      ...(loaded.nextCursor === undefined ? {} : { nextCursor: loaded.nextCursor }),
    },
  });
}

export function unsupportedExternalOperation(res: ServerResponse, operation: string): void {
  const normalized = operation === 'set-status' ? 'set-status' : operation;
  sendJson(res, 405, {
    ok: false,
    error:
      'externally authoritative collections are read-only replicas; use an application tool for source changes',
    code: 'operation_not_supported',
    details: { authority: 'external', operation: normalized },
  });
}

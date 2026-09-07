import type { IncomingMessage } from 'node:http';
import { type ManagedRecordQuery, ManagedRecordQuerySchema } from '@noodle-borg/wire-contracts';
import type { BusinessPermission } from '../business-information/contracts.js';

export function mutationPermission(operation: string): BusinessPermission {
  if (operation === 'migrate-schema') return 'installation:administer';
  if (operation === 'assign') return 'records:assign';
  if (operation === 'set-status') return 'records:status';
  if (operation === 'add-note') return 'records:note';
  return 'records:update';
}

export function requestIdempotencyKey(req: IncomingMessage): string | undefined {
  const value = req.headers['idempotency-key'];
  if (typeof value !== 'string' || value.length < 1 || value.length > 128) return undefined;
  return value;
}

export function expectedRevision(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const revision = (value as { expectedRevision?: unknown }).expectedRevision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision > 0
    ? revision
    : undefined;
}

export function parseBusinessPaging(
  url: URL,
  maximum: number,
): { ok: true; value: { cursor?: string; limit?: number } } | { ok: false; error: string } {
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const rawLimit = url.searchParams.get('limit');
  if (rawLimit === null) return { ok: true, value: cursor === undefined ? {} : { cursor } };
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    return { ok: false, error: `limit must be an integer from 1 to ${maximum}` };
  }
  return { ok: true, value: { ...(cursor === undefined ? {} : { cursor }), limit } };
}

export function parseNativeRecordQuery(
  url: URL,
): { ok: true; value: ManagedRecordQuery } | { ok: false; error: string } {
  try {
    const raw: Record<string, unknown> = {};
    for (const key of ['filters', 'sortField', 'sortDirection', 'createdAtFrom', 'createdAtTo']) {
      const values = url.searchParams.getAll(key);
      if (values.length > 1) throw new Error();
      const value = values[0];
      if (value === undefined) continue;
      if (value.length > 32768) throw new Error();
      raw[key] = key === 'filters' ? JSON.parse(value) : value;
    }
    const parsed = ManagedRecordQuerySchema.safeParse(raw);
    if (!parsed.success) throw new Error();
    return { ok: true, value: parsed.data };
  } catch {
    return {
      ok: false,
      error:
        'Invalid collection query. Use declared scalar filters, sort fields and valid creation date bounds.',
    };
  }
}

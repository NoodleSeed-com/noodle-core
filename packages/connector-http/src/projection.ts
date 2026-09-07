import type { HttpPaginationAggregate } from './http-connector.js';

export interface HttpOperationProjection {
  readonly hiddenFields?: readonly string[];
  readonly widgetMeta?: (
    json: unknown,
    args: Readonly<Record<string, unknown>>,
    output: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  readonly sourceLabel?: string;
  readonly freshness?: {
    readonly ttlMs: number;
    readonly timestamp?: (
      json: unknown,
      args: Readonly<Record<string, unknown>>,
      output: Readonly<Record<string, unknown>>,
    ) => unknown;
  };
}

export function applyProjection(
  projection: HttpOperationProjection,
  mapped: unknown,
  json: unknown,
  args: Readonly<Record<string, unknown>>,
): unknown {
  if (mapped === null || typeof mapped !== 'object' || Array.isArray(mapped)) {
    return mapped;
  }
  const output = cloneJsonObject(mapped as Record<string, unknown>);
  const meta = projectionMeta(projection, json, args, output);
  for (const path of projection.hiddenFields ?? []) {
    deletePath(output, path.split('.').filter(Boolean));
  }
  if (meta !== undefined) output.__noodleResultMeta = { noodle: { projection: meta } };
  return output;
}

function projectionMeta(
  projection: HttpOperationProjection,
  json: unknown,
  args: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  const widgetMeta = projection.widgetMeta?.(json, args, output);
  if (widgetMeta !== undefined && Object.keys(widgetMeta).length > 0) {
    meta.widgetMeta = widgetMeta;
  }
  if (projection.sourceLabel !== undefined) meta.source = { label: projection.sourceLabel };
  const freshness = freshnessMeta(projection, json, args, output);
  if (freshness !== undefined) meta.freshness = freshness;
  const partial = partialMeta(json);
  if (partial !== undefined) meta.partial = partial;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function freshnessMeta(
  projection: HttpOperationProjection,
  json: unknown,
  args: Readonly<Record<string, unknown>>,
  output: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const freshness = projection.freshness;
  if (freshness === undefined) return undefined;
  const rawTimestamp = freshness.timestamp?.(json, args, output);
  const observedAt = Date.now();
  const timestampMs = timestampMillis(rawTimestamp) ?? observedAt;
  return {
    ttlMs: freshness.ttlMs,
    observedAt,
    timestamp: new Date(timestampMs).toISOString(),
    stale: observedAt - timestampMs > freshness.ttlMs,
  };
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function partialMeta(json: unknown): Record<string, unknown> | undefined {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return undefined;
  const aggregate = json as Partial<HttpPaginationAggregate>;
  if (typeof aggregate.partial !== 'boolean') return undefined;
  return {
    value: aggregate.partial,
    ...(aggregate.stopReason !== undefined ? { stopReason: aggregate.stopReason } : {}),
  };
}

function cloneJsonObject(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) out[key] = cloneJsonValue(value);
  return out;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === 'object') {
    return cloneJsonObject(value as Record<string, unknown>);
  }
  return value;
}

function deletePath(target: unknown, segments: readonly string[]): void {
  if (segments.length === 0) return;
  if (Array.isArray(target)) {
    for (const item of target) deletePath(item, segments);
    return;
  }
  if (target === null || typeof target !== 'object') return;
  const record = target as Record<string, unknown>;
  const [head, ...rest] = segments;
  if (head === undefined) return;
  if (rest.length === 0) {
    delete record[head];
    return;
  }
  deletePath(record[head], rest);
}

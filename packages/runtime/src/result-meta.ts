const RESULT_META_KEY = '__noodleResultMeta';

/** @internal Shared with suspension-aware execution and surface adapters. */
export function splitResultMeta(output: unknown): {
  readonly visible: unknown;
  readonly meta?: Record<string, unknown>;
} {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return { visible: output };
  }
  const record = output as Record<string, unknown>;
  if (!Object.hasOwn(record, RESULT_META_KEY)) return { visible: output };
  const rawMeta = record[RESULT_META_KEY];
  const visible: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(record)) {
    if (key !== RESULT_META_KEY) visible[key] = value;
  }
  return {
    visible,
    ...(isPlainRecord(rawMeta) ? { meta: rawMeta } : {}),
  };
}

/** @internal Shared with the suspension-aware flow executor. */
export function attachResultMeta(
  output: Record<string, unknown>,
  metas: readonly Record<string, unknown>[],
): Record<string, unknown> {
  if (metas.length === 0) return output;
  const merged: Record<string, unknown> = {};
  for (const meta of metas) mergeRecords(merged, meta);
  if (Object.keys(merged).length === 0) return output;
  return { ...output, [RESULT_META_KEY]: merged };
}

function mergeRecords(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = target[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      mergeRecords(existing, value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

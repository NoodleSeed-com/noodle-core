import type { PreparedOperationAction } from './result.js';

export function samePreparedAction(
  prepared: PreparedOperationAction,
  reviewed: PreparedOperationAction,
): boolean {
  if (
    prepared.connectorId !== reviewed.connectorId ||
    prepared.connectorVersion !== reviewed.connectorVersion ||
    prepared.operation !== reviewed.operation
  ) {
    return false;
  }
  for (const key of [
    'bindingId',
    'connectionId',
    'connectionConfigRevision',
    'profile',
    'requiredAudience',
  ] as const) {
    if (prepared[key] !== reviewed[key]) return false;
  }
  if (!sameJsonValue(prepared.requiredScopes, reviewed.requiredScopes)) return false;
  if (!sameJsonValue(prepared.presentation, reviewed.presentation)) return false;
  if (!sameJsonValue(prepared.customerRoutes, reviewed.customerRoutes)) return false;
  try {
    return sameJsonValue(prepared.arguments, reviewed.arguments);
  } catch {
    return false;
  }
}

/** Compare persisted JSON values structurally; PostgreSQL JSONB does not preserve object key order. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

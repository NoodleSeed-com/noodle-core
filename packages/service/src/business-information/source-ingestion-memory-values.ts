import { createHash } from 'node:crypto';
import type { SourceBindingRecord, SourceSuppressionRecord } from './source-ingestion-contracts.js';

export function jsonDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fixedDigest(label: string, value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value;
}

export function sourceToken(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 4_096 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function requiredCursor(value: string | undefined): string {
  if (value === undefined) throw new Error('source continuation is missing');
  return sourceToken('source continuation', value);
}

export function requiredScanMode(value: SourceBindingRecord['scanMode']): 'snapshot' | 'changes' {
  if (value !== 'snapshot' && value !== 'changes') throw new Error('source scan mode is missing');
  return value;
}

export function boundedInteger(
  label: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is outside the supported range`);
  }
  return value;
}

export function suppressionReason(value: string): SourceSuppressionRecord['reason'] {
  if (value !== 'customer_request' && value !== 'source_access_revoked') {
    throw new Error('source suppression reason is invalid');
  }
  return value;
}

export function validInstant(label: string, value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} is invalid`);
  return new Date(value).toISOString();
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

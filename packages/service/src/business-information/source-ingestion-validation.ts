import { createHash, createHmac } from 'node:crypto';
import { scopeKey } from './pagination.js';
import type {
  SourceBindingCreate,
  SourceBindingKey,
  SourceBindingRecord,
  SourceSuppressionRecord,
} from './source-ingestion-contracts.js';
import { validateScalar, validateScope } from './validation.js';

export function normalizeSourceBindingCreate(input: SourceBindingCreate): SourceBindingCreate {
  return {
    scope: structuredClone(validateScope(input.scope)),
    collectionKey: validateScalar('source collection key', input.collectionKey, 128),
    id: validateScalar('source binding id', input.id, 128),
    ...(input.bindingReference === undefined
      ? {}
      : {
          bindingReference: validateScalar('source binding reference', input.bindingReference, 128),
        }),
    ...(input.configurationReference === undefined
      ? {}
      : {
          configurationReference: validateScalar(
            'source configuration reference',
            input.configurationReference,
            128,
          ),
        }),
    ...(input.credentialIdentity === undefined
      ? {}
      : {
          credentialIdentity: {
            ...(input.credentialIdentity.generation === undefined
              ? {}
              : {
                  generation: validateScalar(
                    'source credential generation',
                    input.credentialIdentity.generation,
                    128,
                  ),
                }),
            ...(input.credentialIdentity.account === undefined
              ? {}
              : {
                  account: validateScalar(
                    'source credential account',
                    input.credentialIdentity.account,
                    128,
                  ),
                }),
            ...(input.credentialIdentity.configuration === undefined
              ? {}
              : {
                  configuration: validateScalar(
                    'source configuration generation',
                    input.credentialIdentity.configuration,
                    128,
                  ),
                }),
          },
        }),
    generation: sourceInteger(
      'source binding generation',
      input.generation,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    schemaVersion: sourceInteger('source schema version', input.schemaVersion, 1, 1_000_000),
    schemaDigest: sourceDigest('source schema digest', input.schemaDigest),
    queryFingerprint: sourceDigest('source query fingerprint', input.queryFingerprint),
    scan: normalizeOperation(input.scan),
    retentionDays: sourceRetentionDays(input.retentionDays),
    pollIntervalMs: sourceInteger('source poll interval', input.pollIntervalMs, 5_000, 86_400_000),
  };
}

export function sourceBindingCreateFrom(value: SourceBindingRecord): SourceBindingCreate {
  return {
    scope: value.scope,
    collectionKey: value.collectionKey,
    id: value.id,
    ...(value.bindingReference === undefined ? {} : { bindingReference: value.bindingReference }),
    ...(value.configurationReference === undefined
      ? {}
      : { configurationReference: value.configurationReference }),
    ...(value.credentialIdentity === undefined
      ? {}
      : { credentialIdentity: { ...value.credentialIdentity } }),
    generation: value.generation,
    schemaVersion: value.schemaVersion,
    schemaDigest: value.schemaDigest,
    queryFingerprint: value.queryFingerprint,
    scan: value.scan,
    retentionDays: value.retentionDays,
    pollIntervalMs: value.pollIntervalMs,
  };
}

export function sourceBindingFingerprint(value: SourceBindingCreate): string {
  return sourceJsonDigest(value);
}

export function sourceBindingValues(input: SourceBindingKey): string[] {
  const scope = validateScope(input.scope);
  return [
    scope.org,
    scope.app,
    scope.env,
    scope.installationId,
    validateScalar('source collection key', input.collectionKey, 128),
    validateScalar('source binding id', input.id, 128),
  ];
}

export function sourceIdentityDigest(
  identityKey: string,
  binding: SourceBindingRecord,
  sourceId: string,
): string {
  return createHmac('sha256', identityKey)
    .update(
      `${scopeKey(binding.scope)}\0${binding.collectionKey}\0${binding.id}\0${binding.bindingReference ?? binding.id}\0${sourceToken('source record id', sourceId)}`,
    )
    .digest('hex');
}

export function normalizeSourceSuppression(
  input: SourceSuppressionRecord,
): SourceSuppressionRecord {
  const reason = input.reason;
  if (reason !== 'customer_request' && reason !== 'source_access_revoked') {
    throw new Error('source suppression reason is invalid');
  }
  return {
    scope: structuredClone(validateScope(input.scope)),
    collectionKey: validateScalar('source collection key', input.collectionKey, 128),
    id: validateScalar('source binding id', input.id, 128),
    bindingGeneration: sourceInteger(
      'source binding generation',
      input.bindingGeneration,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    sourceIdentityDigest: sourceDigest('source identity digest', input.sourceIdentityDigest),
    reason,
    erasedAt: sourceInstant('source suppression time', input.erasedAt),
  };
}

export function sourceToken(label: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 4_096 || /[\0\r\n]/.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function sourceDigest(label: string, value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return value;
}

export function sourceOperationSignatureDigest(value: string): string {
  const match = /^(?:sha256v2:|sha256:)?([a-f0-9]{64})$/.exec(value);
  if (match?.[1] === undefined) throw new Error('source operation signature is invalid');
  return match[1];
}

export function sourceJsonDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

export function sourceInteger(
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

export function sourceInstant(label: string, value: string | Date): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is invalid`);
  return new Date(milliseconds).toISOString();
}

function normalizeOperation(value: SourceBindingCreate['scan']): SourceBindingCreate['scan'] {
  return {
    connector: validateScalar('source connector', value.connector, 128),
    connectorVersion: validateScalar('source connector version', value.connectorVersion, 128),
    operation: validateScalar('source operation', value.operation, 128),
    signatureDigest: sourceDigest('source operation signature', value.signatureDigest),
  };
}

function sourceRetentionDays(value: number): 7 | 30 | 90 {
  if (value !== 7 && value !== 30 && value !== 90) {
    throw new Error('source retention days must be 7, 30, or 90');
  }
  return value;
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

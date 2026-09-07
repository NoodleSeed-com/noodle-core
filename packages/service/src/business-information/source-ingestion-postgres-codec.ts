import type { QueryResultRow } from 'pg';
import type {
  JsonObject,
  PayloadCipher,
  PayloadCipherContext,
  SealedPayload,
} from './contracts.js';
import type {
  ExternalRecord,
  SourceBindingCreate,
  SourceBindingRecord,
  SourceScanMode,
} from './source-ingestion-contracts.js';
import {
  normalizeSourceBindingCreate,
  sourceInstant,
  sourceInteger,
  sourceToken,
} from './source-ingestion-validation.js';
import { validateManagedPayload, validateScalar, validateScope } from './validation.js';

export interface SourceBindingRow extends QueryResultRow {
  org_slug: string;
  app_slug: string;
  environment: string;
  installation_id: string;
  collection_key: string;
  binding_id: string;
  binding_generation: string | number;
  schema_version: number;
  schema_digest: string;
  query_fingerprint: string;
  retention_days: number;
  poll_interval_ms: number;
  state: string;
  health: string;
  completeness: string;
  revision: string | number;
  fence: string | number;
  scan_generation: string | number;
  scan_mode: string | null;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_successful_sync_at: Date | string | null;
  next_attempt_at: Date | string | null;
  error_code: string | null;
  content_ciphertext: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ExternalSourceRow extends QueryResultRow {
  org_slug: string;
  app_slug: string;
  environment: string;
  installation_id: string;
  collection_key: string;
  binding_id: string;
  binding_generation: string | number;
  record_id: string;
  schema_version: number;
  schema_digest: string;
  revision: string | number;
  completeness: string;
  observed_at: Date | string;
  last_successful_sync_at: Date | string | null;
  retention_expires_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
  content_ciphertext: unknown;
}

export interface SourceBindingContent {
  readonly credentialIdentity?: SourceBindingCreate['credentialIdentity'];
  readonly bindingReference?: string;
  readonly configurationReference?: string;
  readonly scan: SourceBindingCreate['scan'];
  readonly cursor?: string;
  readonly checkpoint?: string;
}

interface ExternalSourceContent {
  readonly sourceId: string;
  readonly sourceVersion?: string;
  readonly record: JsonObject;
}

export async function sealSourceBindingContent(
  cipher: PayloadCipher,
  binding: SourceBindingCreate,
  content: SourceBindingContent,
): Promise<SealedPayload> {
  return sealJson(cipher, bindingContext(binding), content);
}

export async function sourceBindingFromRow(
  row: SourceBindingRow,
  cipher: PayloadCipher,
): Promise<SourceBindingRecord> {
  const generation = safeInteger('stored source binding generation', row.binding_generation, 1);
  const scope = validateScope({
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    installationId: row.installation_id,
  });
  const content = await openJson<SourceBindingContent>(
    cipher,
    bindingContext({
      scope,
      collectionKey: row.collection_key,
      id: row.binding_id,
      generation,
    }),
    row.content_ciphertext,
  );
  const normalized = normalizeSourceBindingCreate({
    scope,
    collectionKey: row.collection_key,
    id: row.binding_id,
    ...(content.credentialIdentity === undefined
      ? {}
      : { credentialIdentity: content.credentialIdentity }),
    ...(content.bindingReference === undefined
      ? {}
      : { bindingReference: content.bindingReference }),
    ...(content.configurationReference === undefined
      ? {}
      : { configurationReference: content.configurationReference }),
    generation,
    schemaVersion: row.schema_version,
    schemaDigest: row.schema_digest,
    queryFingerprint: row.query_fingerprint,
    scan: content.scan,
    retentionDays: retentionDays(row.retention_days),
    pollIntervalMs: row.poll_interval_ms,
  });
  return {
    ...normalized,
    state: bindingState(row.state),
    health: sourceHealth(row.health),
    completeness: completeness(row.completeness),
    revision: safeInteger('stored source binding revision', row.revision, 1),
    fence: safeInteger('stored source fence', row.fence, 0),
    scanGeneration: safeInteger('stored source scan generation', row.scan_generation, 0),
    ...(row.scan_mode === null ? {} : { scanMode: scanMode(row.scan_mode) }),
    ...(content.cursor === undefined
      ? {}
      : { cursor: sourceToken('source cursor', content.cursor) }),
    ...(content.checkpoint === undefined
      ? {}
      : { checkpoint: sourceToken('source checkpoint', content.checkpoint) }),
    ...(row.lease_owner === null
      ? {}
      : { leaseOwner: validateScalar('source lease owner', row.lease_owner, 128) }),
    ...(row.lease_expires_at === null
      ? {}
      : { leaseExpiresAt: sourceInstant('source lease expiry', row.lease_expires_at) }),
    ...(row.last_successful_sync_at === null
      ? {}
      : {
          lastSuccessfulSyncAt: sourceInstant(
            'source successful sync',
            row.last_successful_sync_at,
          ),
        }),
    ...(row.next_attempt_at === null
      ? {}
      : { nextAttemptAt: sourceInstant('source next attempt', row.next_attempt_at) }),
    ...(row.error_code === null
      ? {}
      : { errorCode: validateScalar('source error code', row.error_code, 80) }),
    createdAt: sourceInstant('source binding creation', row.created_at),
    updatedAt: sourceInstant('source binding update', row.updated_at),
  };
}

export async function sealExternalSourceContent(
  cipher: PayloadCipher,
  binding: SourceBindingRecord,
  recordId: string,
  revision: number,
  sourceId: string,
  sourceVersion: string | undefined,
  record: JsonObject,
): Promise<SealedPayload> {
  return sealJson(cipher, recordContext(binding, recordId, revision), {
    sourceId: sourceToken('source record id', sourceId),
    ...(sourceVersion === undefined
      ? {}
      : { sourceVersion: sourceToken('source version', sourceVersion) }),
    record: validateManagedPayload(record),
  });
}

export async function externalSourceFromRow(
  row: ExternalSourceRow,
  cipher: PayloadCipher,
): Promise<ExternalRecord> {
  const revision = safeInteger('stored external record revision', row.revision, 1);
  const scope = validateScope({
    org: row.org_slug,
    app: row.app_slug,
    env: row.environment,
    installationId: row.installation_id,
  });
  const content = await openJson<ExternalSourceContent>(
    cipher,
    {
      ...scope,
      collectionKey: row.collection_key,
      recordId: row.record_id,
      revision,
    },
    row.content_ciphertext,
  );
  return {
    scope,
    collectionKey: validateScalar('source collection key', row.collection_key, 128),
    id: validateScalar('external record id', row.record_id, 128),
    authority: 'external',
    schemaVersion: row.schema_version,
    schemaDigest: row.schema_digest,
    source: {
      bindingId: validateScalar('source binding id', row.binding_id, 128),
      bindingGeneration: safeInteger('stored source binding generation', row.binding_generation, 1),
      id: sourceToken('source record id', content.sourceId),
      ...(content.sourceVersion === undefined
        ? {}
        : { version: sourceToken('source version', content.sourceVersion) }),
    },
    record: validateManagedPayload(content.record),
    revision,
    completeness: completeness(row.completeness),
    observedAt: sourceInstant('external observation', row.observed_at),
    ...(row.last_successful_sync_at === null
      ? {}
      : {
          lastSuccessfulSyncAt: sourceInstant(
            'external successful sync',
            row.last_successful_sync_at,
          ),
        }),
    retentionExpiresAt: sourceInstant('external retention expiry', row.retention_expires_at),
    createdAt: sourceInstant('external record creation', row.created_at),
    updatedAt: sourceInstant('external record update', row.updated_at),
    ...(row.deleted_at === null
      ? {}
      : { deletedAt: sourceInstant('external deletion', row.deleted_at) }),
  };
}

function bindingContext(
  binding: Pick<SourceBindingCreate, 'scope' | 'collectionKey' | 'id' | 'generation'>,
): PayloadCipherContext {
  return {
    ...binding.scope,
    collectionKey: binding.collectionKey,
    recordId: `source-binding:${binding.id}`,
    revision: binding.generation,
  };
}

function recordContext(
  binding: SourceBindingRecord,
  recordId: string,
  revision: number,
): PayloadCipherContext {
  return { ...binding.scope, collectionKey: binding.collectionKey, recordId, revision };
}

async function sealJson(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  value: unknown,
): Promise<SealedPayload> {
  return validateSealed(
    await cipher.seal(new TextEncoder().encode(JSON.stringify(value)), context),
  );
}

async function openJson<T>(
  cipher: PayloadCipher,
  context: PayloadCipherContext,
  value: unknown,
): Promise<T> {
  const opened = await cipher.open(validateSealed(value), context);
  try {
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(opened)) as T;
  } catch {
    throw new Error('source ciphertext did not open to valid JSON');
  }
}

function validateSealed(value: unknown): SealedPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('source payload cipher returned an invalid envelope');
  }
  const input = value as Partial<SealedPayload>;
  if (
    input.version !== 1 ||
    typeof input.algorithm !== 'string' ||
    typeof input.keyId !== 'string' ||
    typeof input.ciphertext !== 'string'
  ) {
    throw new Error('source payload cipher returned an invalid envelope');
  }
  return {
    version: 1,
    algorithm: validateScalar('source cipher algorithm', input.algorithm, 128),
    keyId: validateScalar('source cipher key id', input.keyId, 256),
    ciphertext: validateScalar('source ciphertext', input.ciphertext, 512 * 1024),
  };
}

function safeInteger(label: string, value: string | number, minimum: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return sourceInteger(label, parsed, minimum, Number.MAX_SAFE_INTEGER);
}

function retentionDays(value: number): 7 | 30 | 90 {
  if (value !== 7 && value !== 30 && value !== 90)
    throw new Error('stored source retention is invalid');
  return value;
}

function bindingState(value: string): SourceBindingRecord['state'] {
  if (value !== 'active' && value !== 'paused' && value !== 'revoked') {
    throw new Error('stored source binding state is invalid');
  }
  return value;
}

function sourceHealth(value: string): SourceBindingRecord['health'] {
  if (
    value !== 'initializing' &&
    value !== 'current' &&
    value !== 'stale' &&
    value !== 'paused' &&
    value !== 'reauth_required' &&
    value !== 'failed'
  )
    throw new Error('stored source health is invalid');
  return value;
}

function completeness(value: string): 'complete' | 'incomplete' {
  if (value !== 'complete' && value !== 'incomplete') {
    throw new Error('stored source completeness is invalid');
  }
  return value;
}

function scanMode(value: string): SourceScanMode {
  if (value !== 'snapshot' && value !== 'changes')
    throw new Error('stored source scan mode is invalid');
  return value;
}

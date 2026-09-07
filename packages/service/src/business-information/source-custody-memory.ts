import {
  assertSourceMetadata,
  SOURCE_MAX_REFRESH_KEYS,
  SOURCE_MAX_REPLICA_ROWS,
  SOURCE_METADATA_BYTES,
  SOURCE_ORG_CUSTODY_BYTES,
  SourceCapacityError,
  sourceDatasetCharge,
  sourceJsonBytes,
  sourceRowCost,
} from './source-custody-budget.js';
import type { SourceSuppressionRecord } from './source-ingestion-contracts.js';
import { bindingKey, type StoredRefreshRequest } from './source-ingestion-memory-state.js';
import type { MutableBinding, StoredExternalRecord } from './source-ingestion-memory-types.js';

export interface SourceMemoryState {
  readonly bindings: ReadonlyMap<string, MutableBinding>;
  readonly records: ReadonlyMap<string, StoredExternalRecord>;
  readonly suppressions: ReadonlyMap<string, SourceSuppressionRecord>;
  readonly refresh: ReadonlyMap<string, StoredRefreshRequest>;
}

interface BindingUsage {
  retained: number;
  projected: number;
}
interface InstallationUsage {
  rows: number;
  slots: number;
  refresh: number;
}
interface Usage {
  readonly bindings: Map<string, BindingUsage>;
  readonly organizations: Map<string, number>;
  readonly installations: Map<string, InstallationUsage>;
}

/** Development-only accounting; production maintains the same conservative counters in PostgreSQL. */
export class SourceMemoryCapacity {
  #baselines = new Map<string, number>();
  constructor(private readonly maximum = SOURCE_ORG_CUSTODY_BYTES) {}

  admit(before: SourceMemoryState, after: SourceMemoryState): void {
    const baselines = new Map(this.#baselines);
    const previous = measure(before, this.#baselines);
    const raw = measure(after, baselines);
    for (const [key, { record }] of after.bindings) {
      const old = before.bindings.get(key)?.record;
      if (record.scanMode !== 'snapshot') baselines.delete(key);
      else if (old?.scanMode !== 'snapshot' || old.scanGeneration !== record.scanGeneration) {
        baselines.set(key, raw.bindings.get(key)?.retained ?? 0);
      }
    }
    for (const key of baselines.keys()) if (!after.bindings.has(key)) baselines.delete(key);
    const next = measure(after, baselines);
    for (const [org, bytes] of next.organizations) {
      if (bytes > Math.max(this.maximum, previous.organizations.get(org) ?? 0))
        throw new SourceCapacityError();
    }
    for (const [key, usage] of next.installations) {
      const old = previous.installations.get(key);
      if (
        usage.rows > Math.max(SOURCE_MAX_REPLICA_ROWS, old?.rows ?? 0) ||
        usage.slots > Math.max(2 * SOURCE_MAX_REPLICA_ROWS, old?.slots ?? 0) ||
        usage.refresh > Math.max(SOURCE_MAX_REFRESH_KEYS, old?.refresh ?? 0)
      )
        throw new SourceCapacityError();
    }
    this.#baselines = baselines;
  }
}

function measure(state: SourceMemoryState, baselines: ReadonlyMap<string, number>): Usage {
  const bindings = new Map<string, BindingUsage>();
  const organizations = new Map<string, number>();
  const installations = new Map<string, InstallationUsage>();
  const installation = (key: string) => {
    const scope = key.split('\0').slice(0, 4).join('\0');
    let value = installations.get(scope);
    if (value === undefined) {
      value = { rows: 0, slots: 0, refresh: 0 };
      installations.set(scope, value);
    }
    return value;
  };
  for (const [key, { record }] of state.bindings) {
    const {
      scan,
      credentialIdentity,
      bindingReference,
      configurationReference,
      cursor,
      checkpoint,
      ...metadata
    } = record;
    assertSourceMetadata(metadata);
    const bytes =
      2 * SOURCE_METADATA_BYTES +
      sourceJsonBytes({
        scan,
        credentialIdentity,
        bindingReference,
        configurationReference,
        cursor,
        checkpoint,
      });
    bindings.set(key, { retained: bytes, projected: bytes });
    installation(key);
  }
  for (const stored of state.records.values()) {
    const record = stored.record;
    const key = bindingKey({
      scope: record.scope,
      collectionKey: record.collectionKey,
      id: record.source.bindingId,
    });
    const usage = required(bindings.get(key));
    const { record: payload, source, ...metadata } = record;
    assertSourceMetadata({
      ...metadata,
      source: { bindingId: source.bindingId, bindingGeneration: source.bindingGeneration },
    });
    const live = record.deletedAt === undefined;
    const bytes = sourceRowCost(
      'record',
      live ? sourceJsonBytes({ sourceId: source.id, version: source.version, record: payload }) : 0,
      live,
    );
    usage.retained += bytes;
    usage.projected +=
      live &&
      state.bindings.get(key)?.record.scanMode === 'snapshot' &&
      stored.lastSeenGeneration !== state.bindings.get(key)?.record.scanGeneration
        ? SOURCE_METADATA_BYTES
        : bytes;
    const count = installation(key);
    count.rows += 1;
    count.slots += live ? 2 : 1;
  }
  for (const suppression of state.suppressions.values()) {
    assertSourceMetadata(suppression);
    const key = bindingKey(suppression);
    const usage = required(bindings.get(key));
    usage.retained += SOURCE_METADATA_BYTES;
    usage.projected += SOURCE_METADATA_BYTES;
    installation(key).slots += 1;
  }
  for (const [key, value] of bindings) {
    const org = required(state.bindings.get(key)).record.scope.org;
    organizations.set(
      org,
      (organizations.get(org) ?? SOURCE_METADATA_BYTES) +
        sourceDatasetCharge(value.retained, baselines.get(key), value.projected),
    );
  }
  for (const refresh of state.refresh.values()) {
    assertSourceMetadata(refresh);
    const org = refresh.bindingKey.split('\0')[0];
    if (org === undefined) throw new Error('Missing source receipt scope');
    organizations.set(
      org,
      (organizations.get(org) ?? SOURCE_METADATA_BYTES) + SOURCE_METADATA_BYTES,
    );
    installation(refresh.bindingKey).refresh += 1;
  }
  return { bindings, organizations, installations };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Source custody scope is missing');
  return value;
}

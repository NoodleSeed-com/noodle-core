import { createHash, createHmac, randomUUID } from 'node:crypto';
import { canonicalJson } from '@noodle-borg/compiler';
import type {
  OperationCoordinationIntent,
  OperationCoordinationPort,
  OperationEvidence,
} from '@noodle-borg/runtime';
import type { InstallationScope } from './business-information/contracts.js';

export interface OperationCoordinationRecord {
  readonly scope: InstallationScope;
  readonly resource: string;
  readonly token: string;
  readonly epoch: string;
  readonly generation: string;
  readonly reference: string;
  readonly operationDigest: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly state: 'executing' | 'unknown';
}
export interface OperationCoordinationStore {
  claim(record: OperationCoordinationRecord): Promise<{
    readonly acquired: boolean;
    readonly previous?: OperationCoordinationRecord;
  }>;
  markUnknown(resource: string, token: string): Promise<void>;
  release(resource: string, token: string, resolution: string): Promise<boolean>;
  list(
    scope: InstallationScope,
    limit?: number,
    beforeResource?: string,
  ): Promise<readonly OperationCoordinationRecord[]>;
  resolve(
    scope: InstallationScope,
    resource: string,
    token: string,
    review: { readonly reviewer: string; readonly reason: string },
  ): Promise<boolean>;
}
export interface OperationCoordinationOptions {
  readonly store: OperationCoordinationStore;
  readonly scope: InstallationScope;
  readonly epoch: string;
  readonly identityKey: string;
  readonly now?: () => number;
  readonly authorize: () => Promise<boolean>;
  readonly connectionGeneration: (id: string) => string | undefined;
}

/** The same opaque resource identity is used by ordinary dispatch and reviewed custody migrations. */
export function deriveOperationCoordinationResource(input: {
  readonly scope: InstallationScope;
  readonly connectionId: string;
  readonly namespace: string;
  readonly key: string;
  readonly identityKey: string;
}): string {
  if (
    typeof input.identityKey !== 'string' ||
    input.identityKey.length < 32 ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.connectionId) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(input.namespace) ||
    typeof input.key !== 'string' ||
    input.key.length < 1 ||
    input.key.length > 2048 ||
    ![input.scope.org, input.scope.app, input.scope.env, input.scope.installationId].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 256,
    )
  )
    throw new Error('Invalid coordination resource authority');
  return createHmac('sha256', input.identityKey)
    .update(
      canonicalJson({
        scope: input.scope,
        connectionId: input.connectionId,
        namespace: input.namespace,
        key: input.key,
      }),
    )
    .digest('hex');
}

/** No business payloads, provider-specific logic, automatic retries or time-based unlocks. */
export function createOperationCoordinationPort(
  options: OperationCoordinationOptions,
): OperationCoordinationPort {
  if (options.identityKey.length < 32 || !/^[A-Za-z0-9_-]{16,128}$/.test(options.epoch))
    throw new Error('Invalid coordination authority configuration');
  const now = () => options.now?.() ?? Date.now();
  const authority = async (intent: OperationCoordinationIntent, generation?: string) => {
    const current = options.connectionGeneration(intent.connectionId);
    if (
      !current ||
      (generation !== undefined && current !== generation) ||
      !(await options.authorize())
    )
      throw new Error('Original operation authority unavailable');
    return current;
  };
  return {
    async acquire(intent) {
      validateIntent(intent);
      const generation = await authority(intent);
      // Deliberately excludes deployment, connection generation and execution epoch: replacing an
      // artifact or reconnecting cannot bypass a held resource. Tenant/app/environment remain isolated.
      const resource = deriveOperationCoordinationResource({
        scope: options.scope,
        connectionId: intent.connectionId,
        namespace: intent.namespace,
        key: intent.key,
        identityKey: options.identityKey,
      });
      const startedAt = now();
      const record: OperationCoordinationRecord = {
        scope: options.scope,
        resource,
        token: randomUUID(),
        epoch: options.epoch,
        generation,
        reference: intent.reference,
        operationDigest: createHash('sha256').update(intent.id).digest('hex'),
        startedAt,
        deadline: startedAt + intent.executionBoundMs,
        state: 'executing',
      };
      const claimed = await options.store.claim(record);
      const previous = claimed.previous;
      const recoverable =
        !claimed.acquired &&
        previous !== undefined &&
        previous.generation === generation &&
        previous.epoch === options.epoch &&
        (previous.state === 'unknown' || previous.deadline <= startedAt);
      let resolved = false;
      let finished = false;
      return {
        acquired: claimed.acquired,
        ...(recoverable
          ? {
              previous: {
                reference: previous.reference,
                operationDigest: previous.operationDigest,
              },
            }
          : {}),
        async finish(evidence: OperationEvidence) {
          if (!claimed.acquired || finished) return;
          finished = true;
          // No expiry authorizes a retry. Only proven completion or proof of no dispatched effect
          // releases custody; an outer success message without explicit evidence remains unknown.
          if (evidence.outcome === 'completed' || evidence.outcome === 'rejected') {
            await options.store.release(resource, record.token, evidence.outcome);
          } else await options.store.markUnknown(resource, record.token);
        },
        async resolvePrevious() {
          if (!recoverable || !previous || resolved)
            throw new Error('Prior operation cannot be resolved');
          await authority(intent, generation);
          if (now() > record.deadline) throw new Error('Recovery execution expired');
          if (!(await options.store.release(resource, previous.token, 'source_verified')))
            throw new Error('Prior operation changed before resolution');
          resolved = true;
        },
      };
    },
  };
}

function validateIntent(intent: OperationCoordinationIntent): void {
  if (
    !/^[a-f0-9]{64}$/.test(intent.id) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(intent.connectionId) ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(intent.namespace) ||
    typeof intent.key !== 'string' ||
    intent.key.length < 1 ||
    intent.key.length > 2048 ||
    typeof intent.reference !== 'string' ||
    !/^[A-Za-z0-9._:@/-]{1,256}$/.test(intent.reference) ||
    intent.reference.includes('://') ||
    !Number.isSafeInteger(intent.executionBoundMs) ||
    intent.executionBoundMs < 1 ||
    intent.executionBoundMs > 120000
  )
    throw new Error('Invalid coordination intent');
}

/** Explicit local/test composition; hosted production supplies the PostgreSQL implementation. */
export class InMemoryOperationCoordinationStore implements OperationCoordinationStore {
  readonly records = new Map<string, OperationCoordinationRecord>();
  readonly receipts: {
    readonly record: OperationCoordinationRecord;
    readonly resolution: string;
    readonly reviewer?: string;
    readonly reason?: string;
    readonly resolvedAt: number;
  }[] = [];
  constructor(private readonly now: () => number = Date.now) {}
  async claim(record: OperationCoordinationRecord) {
    const previous = this.records.get(record.resource);
    if (previous && canonicalJson(previous.scope) !== canonicalJson(record.scope))
      throw new Error('Coordination scope mismatch');
    if (previous) return { acquired: false, previous: structuredClone(previous) };
    this.records.set(record.resource, structuredClone(record));
    return { acquired: true };
  }
  async markUnknown(resource: string, token: string) {
    const record = this.records.get(resource);
    if (record?.token === token) this.records.set(resource, { ...record, state: 'unknown' });
  }
  async release(resource: string, token: string, resolution: string) {
    if (!['completed', 'rejected', 'source_verified'].includes(resolution))
      throw new Error('Invalid coordination resolution');
    const record = this.records.get(resource);
    if (!record || record.token !== token) return false;
    if (resolution === 'source_verified')
      this.receipts.push({ record: structuredClone(record), resolution, resolvedAt: this.now() });
    return this.records.delete(resource);
  }
  async list(scope: InstallationScope, limit = 100, beforeResource?: string) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (beforeResource !== undefined && !/^[a-f0-9]{64}$/.test(beforeResource))
    )
      throw new Error('Invalid coordination paging');
    return [...this.records.values()]
      .filter(
        (record) =>
          canonicalJson(record.scope) === canonicalJson(scope) &&
          (!beforeResource || record.resource > beforeResource),
      )
      .sort((a, b) => a.resource.localeCompare(b.resource))
      .slice(0, limit)
      .map((record) => structuredClone(record));
  }
  async resolve(
    scope: InstallationScope,
    resource: string,
    token: string,
    review: { readonly reviewer: string; readonly reason: string },
  ) {
    if (
      ![review.reviewer, review.reason].every(
        (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256,
      )
    )
      throw new Error('Invalid coordination review');
    const record = this.records.get(resource);
    if (
      !record ||
      record.token !== token ||
      canonicalJson(record.scope) !== canonicalJson(scope) ||
      (record.state === 'executing' && record.deadline > this.now())
    )
      return false;
    this.receipts.push({
      record: structuredClone(record),
      resolution: 'reviewed',
      ...review,
      resolvedAt: this.now(),
    });
    return this.records.delete(resource);
  }
}

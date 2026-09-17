import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type CapabilityPolicyRecord,
  type CapabilityPolicyUpdate,
  type CapabilityScope,
  capabilityPolicyUpdateSchema,
  capabilityScopeSchema,
} from './operator-contracts.js';

export * from './operator-contracts.js';

export interface CapabilityPolicyStore {
  readonly durable: boolean;
  get(scope: CapabilityScope): Promise<CapabilityPolicyRecord | undefined>;
  replace(scope: CapabilityScope, update: CapabilityPolicyUpdate): Promise<CapabilityPolicyRecord>;
}
export class CapabilityPolicyConflict extends Error {
  constructor() {
    super('capability_policy_conflict');
  }
}

export function capabilityScopeKey(scope: CapabilityScope): string {
  const parsed = capabilityScopeSchema.parse(scope);
  return JSON.stringify([
    parsed.org,
    parsed.app,
    parsed.env,
    `capability.web-extract.${parsed.name}.provider`,
  ]);
}
export function checkedPolicyUpdate(update: CapabilityPolicyUpdate) {
  const { actor, ...body } = update;
  const parsed = capabilityPolicyUpdateSchema.parse(body);
  z.string().min(1).max(512).parse(actor);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ ...parsed, actor }))
    .digest('hex');
  return { ...parsed, actor, fingerprint };
}

/** Development/test only. Hosted composition rejects a non-durable policy or counter store. */
export class InMemoryCapabilityPolicyStore implements CapabilityPolicyStore {
  readonly durable = false;
  readonly #records = new Map<
    string,
    { record: CapabilityPolicyRecord; mutationId: string; fingerprint: string }
  >();
  async get(scope: CapabilityScope): Promise<CapabilityPolicyRecord | undefined> {
    const entry = this.#records.get(capabilityScopeKey(scope));
    return entry === undefined ? undefined : structuredClone(entry.record);
  }
  async replace(
    scope: CapabilityScope,
    input: CapabilityPolicyUpdate,
  ): Promise<CapabilityPolicyRecord> {
    const key = capabilityScopeKey(scope);
    const update = checkedPolicyUpdate(input);
    const prior = this.#records.get(key);
    if (prior?.mutationId === update.mutationId) {
      if (prior.fingerprint !== update.fingerprint) throw new CapabilityPolicyConflict();
      return structuredClone(prior.record);
    }
    if ((prior?.record.revision ?? 0) !== update.expectedRevision)
      throw new CapabilityPolicyConflict();
    const record = {
      revision: update.expectedRevision + 1,
      policy: update.policy,
      actor: update.actor,
      updatedAt: new Date().toISOString(),
    };
    this.#records.set(key, {
      record,
      mutationId: update.mutationId,
      fingerprint: update.fingerprint,
    });
    return structuredClone(record);
  }
}

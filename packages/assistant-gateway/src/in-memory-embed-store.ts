import { randomBytes } from 'node:crypto';
import {
  PUBLIC_EMBED_ID_PREFIX,
  type PublicEmbedBudget,
  type PublicEmbedRecord,
  type PublicEmbedStore,
} from './embed-store.js';

/** 120 bits of randomness, base36: unguessable enough that an id is never a discovery oracle. */
export function newPublicEmbedId(): string {
  return `${PUBLIC_EMBED_ID_PREFIX}${BigInt(`0x${randomBytes(15).toString('hex')}`)
    .toString(36)
    .padStart(24, '0')
    .slice(0, 24)}`;
}

export function tenantKey(tenant: {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}): string {
  return `${tenant.org}/${tenant.app}/${tenant.env}`;
}

/** Process-local embeds for local development and tests. */
export class InMemoryPublicEmbedStore implements PublicEmbedStore {
  readonly #byId = new Map<string, PublicEmbedRecord>();

  async ensure(input: {
    readonly org: string;
    readonly app: string;
    readonly env: string;
    readonly surfaceMode: 'public' | 'mixed';
    readonly now: Date;
  }): Promise<PublicEmbedRecord> {
    const key = tenantKey(input);
    for (const record of this.#byId.values()) {
      if (record.revokedAt === undefined && tenantKey(record) === key) return record;
    }
    const record: PublicEmbedRecord = {
      embedId: newPublicEmbedId(),
      org: input.org,
      app: input.app,
      env: input.env,
      surfaceMode: input.surfaceMode,
      createdAt: input.now,
    };
    this.#byId.set(record.embedId, record);
    return record;
  }

  async setBudget(
    embedId: string,
    budget: PublicEmbedBudget,
    _now: Date,
  ): Promise<PublicEmbedRecord | undefined> {
    const record = this.#byId.get(embedId);
    if (record === undefined || record.revokedAt !== undefined) return undefined;
    // Each cap set independently, so raising turns does not quietly clear a mint ceiling.
    const updated: PublicEmbedRecord = {
      ...record,
      ...(budget.turnsPerDay !== undefined ? { turnsPerDay: budget.turnsPerDay } : {}),
      ...(budget.mintsPerDay !== undefined ? { mintsPerDay: budget.mintsPerDay } : {}),
      ...(budget.mintsPerAddressHour !== undefined
        ? { mintsPerAddressHour: budget.mintsPerAddressHour }
        : {}),
      ...(budget.turnsPerAddressHour !== undefined
        ? { turnsPerAddressHour: budget.turnsPerAddressHour }
        : {}),
      ...(budget.bridgeToolCallsPerSession !== undefined
        ? { bridgeToolCallsPerSession: budget.bridgeToolCallsPerSession }
        : {}),
      ...(budget.bridgeToolCallsPerDay !== undefined
        ? { bridgeToolCallsPerDay: budget.bridgeToolCallsPerDay }
        : {}),
    };
    this.#byId.set(embedId, updated);
    return updated;
  }

  async lookup(embedId: string): Promise<PublicEmbedRecord | undefined> {
    const record = this.#byId.get(embedId);
    return record === undefined || record.revokedAt !== undefined ? undefined : record;
  }

  async list(tenant: {
    readonly org: string;
    readonly app: string;
    readonly env: string;
  }): Promise<readonly PublicEmbedRecord[]> {
    const key = tenantKey(tenant);
    return [...this.#byId.values()].filter(
      (record) => record.revokedAt === undefined && tenantKey(record) === key,
    );
  }

  async revoke(embedId: string, now: Date): Promise<boolean> {
    const record = this.#byId.get(embedId);
    if (record === undefined || record.revokedAt !== undefined) return false;
    this.#byId.set(embedId, { ...record, revokedAt: now });
    return true;
  }
}

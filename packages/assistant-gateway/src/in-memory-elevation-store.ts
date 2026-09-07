import { randomUUID } from 'node:crypto';
import {
  ASSISTANT_ELEVATION_TTL_MS,
  type AssistantElevationClaim,
  type AssistantElevationRecord,
  type AssistantElevationStore,
  elevationContinuation,
  elevationDigest,
  elevationHashesEqual,
  sameTenant,
} from './elevation-store.js';
import type { TenantRef } from './tenant-ref.js';

/** The in-memory half of the pair. Both run the shared parity suite; neither is the only proof. */
export class InMemoryAssistantElevationStore implements AssistantElevationStore {
  readonly #rows = new Map<string, AssistantElevationRecord>();

  async request(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly tool: string;
    readonly claimableStateHandles?: readonly string[];
    readonly now: Date;
  }): Promise<{ readonly elevation: AssistantElevationRecord; readonly continuation: string }> {
    // Supersede rather than accumulate: one live elevation per session.
    for (const [id, row] of this.#rows) {
      if (row.sessionId === input.sessionId && row.claimedAt === undefined) this.#rows.delete(id);
    }
    const continuation = elevationContinuation();
    const elevation: AssistantElevationRecord = {
      id: `elev_${randomUUID().replaceAll('-', '')}`,
      sessionId: input.sessionId,
      tenant: input.tenant,
      tool: input.tool,
      claimableStateHandles: [...(input.claimableStateHandles ?? [])].sort(),
      continuationHash: elevationDigest(continuation),
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + ASSISTANT_ELEVATION_TTL_MS).toISOString(),
    };
    this.#rows.set(elevation.id, elevation);
    return { elevation, continuation };
  }

  async claim(input: {
    readonly continuation: string;
    readonly tenant: TenantRef;
    readonly now: Date;
  }): Promise<AssistantElevationClaim> {
    const hash = elevationDigest(input.continuation);
    const found = [...this.#rows.values()].find((row) =>
      elevationHashesEqual(row.continuationHash, hash),
    );
    if (!found || found.claimedAt !== undefined) return { ok: false, reason: 'unknown' };
    // Tenant before expiry: a client reaching for another tenant's conversation should read as a tenant
    // violation whether or not the value happened to be stale.
    if (!sameTenant(found.tenant, input.tenant)) return { ok: false, reason: 'tenant_mismatch' };
    if (Date.parse(found.expiresAt) <= input.now.getTime()) return { ok: false, reason: 'expired' };
    const claimed: AssistantElevationRecord = { ...found, claimedAt: input.now.toISOString() };
    this.#rows.set(found.id, claimed);
    return { ok: true, elevation: claimed };
  }
}

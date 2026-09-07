import { randomUUID } from 'node:crypto';
import {
  type AssistantContinuityClaim,
  type AssistantContinuityContext,
  type AssistantContinuityRecord,
  type AssistantContinuityStore,
  continuityDigest,
  continuityHandle,
  continuityHashesEqual,
  continuityMaxRestores,
  continuityWindowMs,
  sameContinuityContext,
} from './continuity-store.js';
import type { TenantRef } from './tenant-ref.js';

/** The in-memory half of the pair. Both run the shared parity suite; neither is the only proof. */
export class InMemoryAssistantContinuityStore implements AssistantContinuityStore {
  readonly #rows = new Map<string, AssistantContinuityRecord>();

  async issue(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly context: AssistantContinuityContext;
    readonly windowMs?: number;
    readonly maxRestores?: number;
    readonly now: Date;
  }): Promise<{ readonly record: AssistantContinuityRecord; readonly handle: string } | undefined> {
    return this.#write({ ...input, restoreCount: 0 });
  }

  async claim(input: {
    readonly handle: string;
    readonly context: AssistantContinuityContext;
    readonly now: Date;
  }): Promise<AssistantContinuityClaim> {
    const hash = continuityDigest(input.handle);
    const found = [...this.#rows.values()].find((row) =>
      continuityHashesEqual(row.handleHash, hash),
    );
    if (!found || found.claimedAt !== undefined) return { ok: false, reason: 'unknown' };
    // Context before expiry: a handle replayed from somewhere it was never issued should read as the
    // exfiltration signal it is, whether or not the value happened to be stale by then.
    if (!sameContinuityContext(found.context, input.context)) {
      return { ok: false, reason: 'context_mismatch' };
    }
    if (Date.parse(found.expiresAt) <= input.now.getTime()) return { ok: false, reason: 'expired' };

    const restoreCount = found.restoreCount + 1;
    const claimed: AssistantContinuityRecord = {
      ...found,
      restoreCount,
      claimedAt: input.now.toISOString(),
    };
    this.#rows.set(found.id, claimed);
    if (restoreCount >= found.maxRestores) return { ok: true, record: claimed };

    const rotated = this.#write({
      sessionId: found.sessionId,
      tenant: found.tenant,
      context: found.context,
      // Re-derive from the record so a rotation can never widen what the first issue clamped.
      windowMs: Date.parse(found.expiresAt) - Date.parse(found.createdAt),
      maxRestores: found.maxRestores,
      restoreCount,
      now: input.now,
    });
    return rotated === undefined
      ? { ok: true, record: claimed }
      : { ok: true, record: claimed, handle: rotated.handle };
  }

  async sweepExpired(input: { readonly now: Date }): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.#rows) {
      if (row.claimedAt !== undefined || Date.parse(row.expiresAt) <= input.now.getTime()) {
        this.#rows.delete(id);
        removed++;
      }
    }
    return removed;
  }

  #write(input: {
    readonly sessionId: string;
    readonly tenant: TenantRef;
    readonly context: AssistantContinuityContext;
    readonly windowMs?: number;
    readonly maxRestores?: number;
    readonly restoreCount: number;
    readonly now: Date;
  }): { readonly record: AssistantContinuityRecord; readonly handle: string } | undefined {
    const windowMs = continuityWindowMs(input.windowMs);
    const maxRestores = continuityMaxRestores(input.maxRestores);
    if (windowMs === 0 || maxRestores === 0) return undefined;

    // Supersede rather than accumulate: one live handle per session.
    for (const [id, row] of this.#rows) {
      if (row.sessionId === input.sessionId && row.claimedAt === undefined) this.#rows.delete(id);
    }
    const handle = continuityHandle();
    const record: AssistantContinuityRecord = {
      id: `cont_${randomUUID().replaceAll('-', '')}`,
      sessionId: input.sessionId,
      tenant: input.tenant,
      context: input.context,
      handleHash: continuityDigest(handle),
      restoreCount: input.restoreCount,
      maxRestores,
      createdAt: input.now.toISOString(),
      expiresAt: new Date(input.now.getTime() + windowMs).toISOString(),
    };
    this.#rows.set(record.id, record);
    return { record, handle };
  }
}

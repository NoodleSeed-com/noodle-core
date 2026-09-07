import { expect, it } from 'vitest';
import {
  ASSISTANT_CONTINUITY_MAX_RESTORES,
  ASSISTANT_CONTINUITY_RESTORE_CEILING,
  ASSISTANT_CONTINUITY_WINDOW_CEILING_MS,
  ASSISTANT_CONTINUITY_WINDOW_MS,
  type AssistantContinuityContext,
  type AssistantContinuityStore,
} from '../src/continuity-store.js';

const TENANT = { org: 'acme', app: 'site', env: 'prod' } as const;
const CONTEXT: AssistantContinuityContext = {
  embedId: 'emb_1',
  originHash: 'origin-a',
  visitorHash: 'visitor-a',
};
const NOW = new Date('2030-01-01T00:00:00.000Z');

/**
 * The contract both continuity stores must satisfy (ADR 0223, clauses 11-16).
 *
 * Possession of an anonymous continuity handle is sufficient by itself — there is no second factor the
 * way the sign-in ticket has the customer's client credentials — so every bound below is the security
 * property rather than a convenience, and asserting one only against the in-memory store would leave
 * the durable path free to violate it in production.
 */
export function describeContinuityStore(
  name: string,
  create: () => AssistantContinuityStore,
): void {
  const issue = async (
    store: AssistantContinuityStore,
    overrides: {
      readonly sessionId?: string;
      readonly context?: AssistantContinuityContext;
      readonly windowMs?: number;
      readonly maxRestores?: number;
      readonly now?: Date;
    } = {},
  ) =>
    store.issue({
      sessionId: overrides.sessionId ?? 'sess_1',
      tenant: TENANT,
      context: overrides.context ?? CONTEXT,
      windowMs: overrides.windowMs,
      maxRestores: overrides.maxRestores,
      now: overrides.now ?? NOW,
    });

  it(`${name}: returns a handle that is never stored in the clear`, async () => {
    const store = create();
    const issued = await issue(store);
    if (issued === undefined) throw new Error('expected a handle');

    expect(issued.handle).toMatch(/^cnt_/);
    expect(issued.record.handleHash).not.toBe(issued.handle);
    expect(issued.record.handleHash).not.toContain(issued.handle.slice(4));
    expect(JSON.stringify(issued.record)).not.toContain(issued.handle);
  });

  it(`${name}: spends a handle exactly once and rotates to a fresh one`, async () => {
    const store = create();
    const issued = await issue(store);
    if (issued === undefined) throw new Error('expected a handle');

    const claimed = await store.claim({ handle: issued.handle, context: CONTEXT, now: NOW });
    expect(claimed.ok).toBe(true);
    // Rotation is what keeps a captured value worthless after one use.
    expect(claimed.ok && claimed.handle).toBeTypeOf('string');
    expect(claimed.ok && claimed.handle).not.toBe(issued.handle);

    const replay = await store.claim({ handle: issued.handle, context: CONTEXT, now: NOW });
    expect(replay).toEqual({ ok: false, reason: 'unknown' });
  });

  it(`${name}: refuses a handle presented from another embed, origin, or visitor`, async () => {
    for (const wrong of [
      { ...CONTEXT, embedId: 'emb_other' },
      { ...CONTEXT, originHash: 'origin-b' },
      { ...CONTEXT, visitorHash: 'visitor-b' },
    ]) {
      const store = create();
      const issued = await issue(store);
      if (issued === undefined) throw new Error('expected a handle');

      // The exfiltration case: a handle lifted from storage and replayed somewhere else. This is the
      // refusal worth alerting on, so it must not collapse into `unknown`.
      expect(await store.claim({ handle: issued.handle, context: wrong, now: NOW })).toEqual({
        ok: false,
        reason: 'context_mismatch',
      });

      // A probe must not consume the handle, or an attacker could deny the rightful visitor.
      const rightful = await store.claim({ handle: issued.handle, context: CONTEXT, now: NOW });
      expect(rightful.ok).toBe(true);
    }
  });

  it(`${name}: refuses a handle past its window`, async () => {
    const store = create();
    const issued = await issue(store);
    if (issued === undefined) throw new Error('expected a handle');
    const late = new Date(NOW.getTime() + ASSISTANT_CONTINUITY_WINDOW_MS + 1);

    expect(await store.claim({ handle: issued.handle, context: CONTEXT, now: late })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it(`${name}: refuses a value that was never issued`, async () => {
    const store = create();
    expect(await store.claim({ handle: 'cnt_invented', context: CONTEXT, now: NOW })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it(`${name}: ends the chain by withholding the next handle, not by refusing the visitor`, async () => {
    const store = create();
    const issued = await issue(store, { maxRestores: 2 });
    if (issued === undefined) throw new Error('expected a handle');

    const first = await store.claim({ handle: issued.handle, context: CONTEXT, now: NOW });
    expect(first.ok && first.handle).toBeTypeOf('string');
    if (!first.ok || first.handle === undefined) throw new Error('expected a rotated handle');

    // The last permitted restore still shows the visitor their text; it simply hands back nothing, so
    // the next page has nothing to present and starts fresh. No refusal code is needed for that.
    const last = await store.claim({ handle: first.handle, context: CONTEXT, now: NOW });
    expect(last.ok).toBe(true);
    expect(last.ok && last.handle).toBeUndefined();
    expect(last.ok && last.record.restoreCount).toBe(2);
  });

  it(`${name}: clamps the window to the structural ceiling a caller cannot raise`, async () => {
    const store = create();
    const issued = await issue(store, { windowMs: ASSISTANT_CONTINUITY_WINDOW_CEILING_MS * 10 });
    if (issued === undefined) throw new Error('expected a handle');

    const ceiling = NOW.getTime() + ASSISTANT_CONTINUITY_WINDOW_CEILING_MS;
    expect(Date.parse(issued.record.expiresAt)).toBe(ceiling);
    // Past the ceiling the handle is dead however wide the caller asked for.
    expect(
      await store.claim({ handle: issued.handle, context: CONTEXT, now: new Date(ceiling + 1) }),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it(`${name}: clamps the restore chain to the structural ceiling`, async () => {
    const store = create();
    const issued = await issue(store, { maxRestores: ASSISTANT_CONTINUITY_RESTORE_CEILING + 50 });
    if (issued === undefined) throw new Error('expected a handle');
    expect(issued.record.maxRestores).toBe(ASSISTANT_CONTINUITY_RESTORE_CEILING);
  });

  it(`${name}: treats a zero window or zero chain as the deploy-free kill switch`, async () => {
    const store = create();
    expect(await issue(store, { windowMs: 0 })).toBeUndefined();
    expect(await issue(store, { maxRestores: 0 })).toBeUndefined();
    // A negative or malformed request must fail closed too, never wrap into a wide window.
    expect(await issue(store, { windowMs: -1 })).toBeUndefined();
  });

  it(`${name}: applies the documented defaults when the caller declares nothing`, async () => {
    const store = create();
    const issued = await issue(store);
    if (issued === undefined) throw new Error('expected a handle');

    expect(Date.parse(issued.record.expiresAt) - NOW.getTime()).toBe(
      ASSISTANT_CONTINUITY_WINDOW_MS,
    );
    expect(issued.record.maxRestores).toBe(ASSISTANT_CONTINUITY_MAX_RESTORES);
  });

  it(`${name}: supersedes a session's unclaimed handle rather than accumulating them`, async () => {
    const store = create();
    const first = await issue(store);
    const second = await issue(store);
    if (first === undefined || second === undefined) throw new Error('expected handles');

    // Each turn issues a new handle; the previous one must stop working, or a conversation would
    // accumulate one live key per turn.
    expect(await store.claim({ handle: first.handle, context: CONTEXT, now: NOW })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect((await store.claim({ handle: second.handle, context: CONTEXT, now: NOW })).ok).toBe(
      true,
    );
  });

  it(`${name}: keeps separate sessions independent`, async () => {
    const store = create();
    const one = await issue(store, { sessionId: 'sess_1' });
    const two = await issue(store, { sessionId: 'sess_2' });
    if (one === undefined || two === undefined) throw new Error('expected handles');

    const claimed = await store.claim({ handle: one.handle, context: CONTEXT, now: NOW });
    expect(claimed.ok && claimed.record.sessionId).toBe('sess_1');
    expect((await store.claim({ handle: two.handle, context: CONTEXT, now: NOW })).ok).toBe(true);
  });

  it(`${name}: sweeps spent and expired rows without touching a live handle`, async () => {
    const store = create();
    const stale = await issue(store, { sessionId: 'sess_stale' });
    const spent = await issue(store, { sessionId: 'sess_spent' });
    if (stale === undefined || spent === undefined) throw new Error('expected handles');
    await store.claim({ handle: spent.handle, context: CONTEXT, now: NOW });

    const later = new Date(NOW.getTime() + ASSISTANT_CONTINUITY_WINDOW_MS + 1);
    const live = await issue(store, { sessionId: 'sess_live', now: later });
    if (live === undefined) throw new Error('expected a handle');

    // Retention bounds the table; it must never be what enforces the window, so a handle still inside
    // its window has to survive a sweep that runs past another handle's expiry.
    expect(await store.sweepExpired({ now: later })).toBeGreaterThanOrEqual(2);
    expect((await store.claim({ handle: live.handle, context: CONTEXT, now: later })).ok).toBe(
      true,
    );
    expect(await store.claim({ handle: stale.handle, context: CONTEXT, now: later })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it(`${name}: carries the restore count across rotations`, async () => {
    const store = create();
    const issued = await issue(store);
    if (issued === undefined) throw new Error('expected a handle');

    let handle: string | undefined = issued.handle;
    for (let restore = 1; restore <= ASSISTANT_CONTINUITY_MAX_RESTORES; restore++) {
      if (handle === undefined) throw new Error(`chain ended early at restore ${restore}`);
      const claimed: Awaited<ReturnType<AssistantContinuityStore['claim']>> = await store.claim({
        handle,
        context: CONTEXT,
        now: NOW,
      });
      if (!claimed.ok) throw new Error(`restore ${restore} refused: ${claimed.reason}`);
      expect(claimed.record.restoreCount).toBe(restore);
      handle = claimed.handle;
    }
    // The default chain is spent, so nothing survives to the next page.
    expect(handle).toBeUndefined();
  });
}

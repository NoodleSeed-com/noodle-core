import { expect, it } from 'vitest';
import type { AssistantStore, TenantRef } from '../src/index.js';

/**
 * The per-session turn bound (admission tier 1), asserted identically against every store.
 *
 * `consumeTurn` exists as one seam rather than a read-then-write in the route because two turns arriving
 * together at count 19 is exactly the race a read-then-write loses. A behaviour proven only against the
 * in-memory store is one the durable path is free to violate in production, so both run this suite.
 */
export function describeSessionTurns(
  label: string,
  open: () => Promise<{
    readonly store: AssistantStore;
    readonly newSessionId: () => Promise<string>;
  }>,
): void {
  it(`${label}: counts turns up to the limit and refuses the one past it`, async () => {
    const { store, newSessionId } = await open();
    const id = await newSessionId();

    for (let turn = 1; turn <= 3; turn += 1) {
      expect(await store.consumeTurn(id, 3)).toEqual({ allowed: true, turnCount: turn });
    }
    // Refused turns must not advance the count, or a spent session would keep climbing forever.
    expect(await store.consumeTurn(id, 3)).toEqual({ allowed: false, turnCount: 3 });
    expect(await store.consumeTurn(id, 3)).toEqual({ allowed: false, turnCount: 3 });
  });

  it(`${label}: never exceeds the limit under concurrency`, async () => {
    const { store, newSessionId } = await open();
    const id = await newSessionId();

    const results = await Promise.all(Array.from({ length: 12 }, () => store.consumeTurn(id, 5)));

    expect(results.filter((result) => result.allowed)).toHaveLength(5);
    // Every admitted turn got a distinct number: no two callers were handed the same slot.
    const admitted = results.filter((r) => r.allowed).map((r) => r.turnCount);
    expect(new Set(admitted).size).toBe(5);
  });

  it(`${label}: refuses every turn when the limit is zero`, async () => {
    const { store, newSessionId } = await open();
    expect(await store.consumeTurn(await newSessionId(), 0)).toEqual({
      allowed: false,
      turnCount: 0,
    });
  });

  it(`${label}: refuses a session that does not exist rather than inventing one`, async () => {
    const { store } = await open();
    expect(await store.consumeTurn('ses_missing', 20)).toEqual({ allowed: false, turnCount: 0 });
  });

  it(`${label}: counts each session separately`, async () => {
    const { store, newSessionId } = await open();
    const first = await newSessionId();
    const second = await newSessionId();

    await store.consumeTurn(first, 5);
    await store.consumeTurn(first, 5);

    expect(await store.consumeTurn(second, 5)).toEqual({ allowed: true, turnCount: 1 });
  });

  it(`${label}: claims a once-per-session model tool atomically and can release a failed claim`, async () => {
    const { store, newSessionId } = await open();
    const id = await newSessionId();

    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claimModelToolUse(id, 'show_product_path')),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.releaseModelToolUse(id, 'show_product_path')).toBe(true);
    expect(await store.claimModelToolUse(id, 'show_product_path')).toBe(true);
    expect(await store.claimModelToolUse(id, 'show_product_path')).toBe(false);
  });

  it(`${label}: generates initial suggestions once and replays the detached result`, async () => {
    const { store, newSessionId } = await open();
    const id = await newSessionId();
    const claims = await Promise.all(
      Array.from({ length: 8 }, () => store.claimInitialSuggestions(id)),
    );
    expect(claims.filter((claim) => claim.disposition === 'generate')).toHaveLength(1);
    expect(claims.filter((claim) => claim.disposition === 'unavailable')).toHaveLength(7);

    const prompts = ['Show my account', 'What can I do next?'];
    expect(await store.completeInitialSuggestions(id, prompts)).toBe(true);
    const replay = await store.claimInitialSuggestions(id);
    expect(replay).toEqual({ disposition: 'ready', prompts });
    if (replay.disposition === 'ready') (replay.prompts as string[])[0] = 'mutated';
    expect(await store.claimInitialSuggestions(id)).toEqual({ disposition: 'ready', prompts });
  });

  it(`${label}: stores, replaces, and clears the latest follow-up set`, async () => {
    const { store, newSessionId } = await open();
    const id = await newSessionId();
    expect(
      await store.replaceLatestSuggestions(id, {
        phase: 'follow_up',
        prompts: ['What happens next?'],
      }),
    ).toBe(true);
    expect(await store.replaceLatestSuggestions(id, undefined)).toBe(true);
    expect(await store.replaceLatestSuggestions('ses_missing', undefined)).toBe(false);
  });
}

export const PARITY_TENANT = (org: string): TenantRef => ({ org, app: 'smoke', env: 'prod' });

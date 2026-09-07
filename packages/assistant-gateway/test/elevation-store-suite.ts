import { expect, it } from 'vitest';
import type { AssistantElevationStore } from '../src/elevation-store.js';
import { ASSISTANT_ELEVATION_TTL_MS } from '../src/elevation-store.js';

const TENANT = { org: 'acme', app: 'site', env: 'prod' } as const;
const OTHER = { org: 'rival', app: 'site', env: 'prod' } as const;
const NOW = new Date('2030-01-01T00:00:00.000Z');

/**
 * The contract both elevation stores must satisfy.
 *
 * A behaviour asserted only against the in-memory store is one the durable path is free to violate in
 * production, and every rule here is a security property rather than a convenience.
 */
export function describeElevationStore(name: string, create: () => AssistantElevationStore): void {
  const request = async (store: AssistantElevationStore, sessionId = 'sess_1', now = NOW) =>
    store.request({ sessionId, tenant: TENANT, tool: 'my_orders', now });

  it(`${name}: returns a continuation that is never stored in the clear`, async () => {
    const store = create();
    const { elevation, continuation } = await request(store);

    expect(continuation).toMatch(/^elv_/);
    expect(elevation.continuationHash).not.toBe(continuation);
    expect(elevation.continuationHash).not.toContain(continuation.slice(4));
    expect(JSON.stringify(elevation)).not.toContain(continuation);
  });

  it(`${name}: spends a continuation exactly once`, async () => {
    const store = create();
    const { continuation } = await request(store);

    const first = await store.claim({ continuation, tenant: TENANT, now: NOW });
    expect(first.ok).toBe(true);

    // The replay the plan named: a captured continuation must not elevate a second time.
    const replay = await store.claim({ continuation, tenant: TENANT, now: NOW });
    expect(replay).toEqual({ ok: false, reason: 'unknown' });
  });

  it(`${name}: refuses a continuation spent by another tenant's client`, async () => {
    const store = create();
    const { continuation } = await request(store);

    // The cross-tenant hijack: a real client, real credentials, someone else's conversation.
    const stolen = await store.claim({ continuation, tenant: OTHER, now: NOW });
    expect(stolen).toEqual({ ok: false, reason: 'tenant_mismatch' });

    // And it must not have been consumed by the refusal, or a probe would deny the rightful owner.
    const rightful = await store.claim({ continuation, tenant: TENANT, now: NOW });
    expect(rightful.ok).toBe(true);
  });

  it(`${name}: refuses a continuation past its window`, async () => {
    const store = create();
    const { continuation } = await request(store);
    const late = new Date(NOW.getTime() + ASSISTANT_ELEVATION_TTL_MS + 1);

    expect(await store.claim({ continuation, tenant: TENANT, now: late })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it(`${name}: refuses a value that was never issued`, async () => {
    const store = create();
    expect(await store.claim({ continuation: 'elv_invented', tenant: TENANT, now: NOW })).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it(`${name}: supersedes an unclaimed request rather than accumulating capabilities`, async () => {
    const store = create();
    const first = await request(store);
    const second = await request(store);

    // A model that asks twice must not leave two live keys to the same conversation.
    expect(
      await store.claim({ continuation: first.continuation, tenant: TENANT, now: NOW }),
    ).toEqual({ ok: false, reason: 'unknown' });
    expect(
      (await store.claim({ continuation: second.continuation, tenant: TENANT, now: NOW })).ok,
    ).toBe(true);
  });

  it(`${name}: keeps separate sessions independent`, async () => {
    const store = create();
    const one = await request(store, 'sess_1');
    const two = await request(store, 'sess_2');

    const claimed = await store.claim({ continuation: one.continuation, tenant: TENANT, now: NOW });
    expect(claimed.ok && claimed.elevation.sessionId).toBe('sess_1');
    // Opening one session's elevation must not have superseded another's.
    expect(
      (await store.claim({ continuation: two.continuation, tenant: TENANT, now: NOW })).ok,
    ).toBe(true);
  });
}

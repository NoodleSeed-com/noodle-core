import { expect, it } from 'vitest';
import type { SearchBudgetStore } from '../src/budget.js';

/**
 * One behavioural contract for every search-budget store (ADR 0202 as amended): an org-pooled
 * monthly ceiling with per-app sub-caps, consumed pre-spend and atomically — a refused request
 * spends nothing at either granularity, and a zero ceiling blocks immediately (the kill-switch
 * semantic shared with admission limits).
 */
export function describeSearchBudgetStore(
  makeStore: (now?: () => Date) => Promise<SearchBudgetStore>,
): void {
  const scope = { org: 'acme', app: 'site' } as const;
  const ceilings = { org: 100, app: 60 } as const;

  it('grants within both ceilings and tracks app and org consumption', async () => {
    const store = await makeStore();
    const decision = await store.consume(scope, 30, ceilings);
    expect(decision.granted).toBe(true);
    expect(decision.state.appConsumed).toBe(30);
    expect(decision.state.orgConsumed).toBe(30);
    const other = await store.consume({ org: 'acme', app: 'docs' }, 20, ceilings);
    expect(other.granted).toBe(true);
    expect(other.state.appConsumed).toBe(20);
    expect(other.state.orgConsumed).toBe(50);
  });

  it('refuses past the app sub-cap without spending anything', async () => {
    const store = await makeStore();
    await store.consume(scope, 55, ceilings);
    const refused = await store.consume(scope, 10, ceilings);
    expect(refused.granted).toBe(false);
    expect(refused.state.appConsumed).toBe(55);
    expect(refused.state.orgConsumed).toBe(55);
    const boundary = await store.consume(scope, 5, ceilings);
    expect(boundary.granted).toBe(true);
    expect(boundary.state.appConsumed).toBe(60);
  });

  it('refuses when the org pool is exhausted across apps without spending anything', async () => {
    const store = await makeStore();
    await store.consume({ org: 'acme', app: 'a' }, 60, ceilings);
    await store.consume({ org: 'acme', app: 'b' }, 35, ceilings);
    const refused = await store.consume({ org: 'acme', app: 'c' }, 10, ceilings);
    expect(refused.granted).toBe(false);
    expect(refused.state.orgConsumed).toBe(95);
    expect(refused.state.appConsumed).toBe(0);
  });

  it('blocks immediately on a zero ceiling (kill switch)', async () => {
    const store = await makeStore();
    const orgKilled = await store.consume(scope, 1, { org: 0, app: 60 });
    expect(orgKilled.granted).toBe(false);
    const appKilled = await store.consume(scope, 1, { org: 100, app: 0 });
    expect(appKilled.granted).toBe(false);
    expect(appKilled.state.appConsumed).toBe(0);
    expect(appKilled.state.orgConsumed).toBe(0);
  });

  it('isolates orgs from each other', async () => {
    const store = await makeStore();
    await store.consume(scope, 50, ceilings);
    const other = await store.peek({ org: 'other', app: 'site' }, ceilings);
    expect(other.orgConsumed).toBe(0);
    expect(other.appConsumed).toBe(0);
  });

  it('peek never consumes', async () => {
    const store = await makeStore();
    await store.consume(scope, 10, ceilings);
    await store.peek(scope, ceilings);
    const state = await store.peek(scope, ceilings);
    expect(state.appConsumed).toBe(10);
    expect(state.orgConsumed).toBe(10);
  });

  it('resets in a new calendar month window', async () => {
    let current = new Date(Date.UTC(2026, 7, 16));
    const store = await makeStore(() => current);
    await store.consume(scope, 40, ceilings);
    current = new Date(Date.UTC(2026, 8, 1));
    const fresh = await store.consume(scope, 5, ceilings);
    expect(fresh.granted).toBe(true);
    expect(fresh.state.appConsumed).toBe(5);
    expect(fresh.state.orgConsumed).toBe(5);
    expect(fresh.state.month).toBe(9);
  });
}

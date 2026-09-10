import { expect, it } from 'vitest';
import { isPublicEmbedId, type PublicEmbedStore } from '../src/embed-store.js';

/** One contract for every embed store, so the durable path cannot drift from the in-memory one. */
export function describeEmbedStore(makeStore: () => Promise<PublicEmbedStore>): void {
  const now = new Date('2030-04-01T10:00:00Z');
  const tenant = () => ({
    org: `org-${Math.random().toString(36).slice(2, 8)}`,
    app: 'site',
    env: 'prod',
  });

  it('mints a self-describing non-secret id', async () => {
    const store = await makeStore();
    const record = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    expect(isPublicEmbedId(record.embedId)).toBe(true);
    // Nothing secret-shaped may ride along: the whole record is printed-in-page-source safe.
    expect(Object.keys(record)).not.toContain('secret');
    expect(Object.keys(record)).not.toContain('secretHash');
  });

  it('is idempotent, so a redeploy never invalidates a pasted snippet', async () => {
    const store = await makeStore();
    const target = tenant();
    const first = await store.ensure({ ...target, surfaceMode: 'public', now });
    const second = await store.ensure({
      ...target,
      surfaceMode: 'public',
      now: new Date('2030-06-01T10:00:00Z'),
    });
    expect(second.embedId).toBe(first.embedId);
    expect(second.createdAt.toISOString()).toBe(first.createdAt.toISOString());
  });

  it('keeps ids distinct per tenant surface', async () => {
    const store = await makeStore();
    const a = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    const b = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    expect(a.embedId).not.toBe(b.embedId);
  });

  it('resolves a live id and reports its surface mode', async () => {
    const store = await makeStore();
    const target = tenant();
    const created = await store.ensure({ ...target, surfaceMode: 'mixed', now });
    const found = await store.lookup(created.embedId);
    expect(found).toMatchObject({ embedId: created.embedId, surfaceMode: 'mixed', ...target });
  });

  it('resolves nothing for an unknown or revoked id', async () => {
    const store = await makeStore();
    expect(await store.lookup('pub_doesnotexistdoesnotexist')).toBeUndefined();

    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    expect(await store.revoke(created.embedId, now)).toBe(true);
    // Revocation is the operator's off-switch for one pasted snippet; it must stop resolving at all.
    expect(await store.lookup(created.embedId)).toBeUndefined();
    expect(await store.revoke(created.embedId, now)).toBe(false);
  });

  it('mints a fresh id after revocation rather than reviving the old one', async () => {
    const store = await makeStore();
    const target = tenant();
    const first = await store.ensure({ ...target, surfaceMode: 'public', now });
    await store.revoke(first.embedId, now);
    const second = await store.ensure({ ...target, surfaceMode: 'public', now });
    expect(second.embedId).not.toBe(first.embedId);
    expect(await store.lookup(second.embedId)).toBeDefined();
  });

  it('distinguishes absent allocation from revocation without replacing a revoked id during recovery', async () => {
    const store = await makeStore();
    const target = tenant();
    const input = {
      ...target,
      surfaceMode: 'public' as const,
      now,
      allowRevokedReplacement: false,
    };
    expect(await store.list(target, { includeRevoked: true })).toEqual([]);
    const first = await store.ensure(input);
    await store.setBudget(first.embedId, { turnsPerDay: 0 }, now);
    expect(await store.ensure(input)).toMatchObject({ embedId: first.embedId, turnsPerDay: 0 });
    await store.revoke(first.embedId, now);
    expect(await store.list(target)).toEqual([]);
    expect(await store.list(target, { includeRevoked: true })).toEqual([
      expect.objectContaining({ embedId: first.embedId, revokedAt: now }),
    ]);
    expect(await store.list(tenant(), { includeRevoked: true })).toEqual([]);
    await expect(store.ensure(input)).rejects.toThrow();
    expect(await store.lookup(first.embedId)).toBeUndefined();
    expect(await store.list(target, { includeRevoked: true })).toHaveLength(1);
    const replacement = await store.ensure({ ...target, surfaceMode: 'public', now });
    expect((await store.ensure(input)).embedId).toBe(replacement.embedId);
  });

  it('starts with no budget override, meaning the deployment defaults apply', async () => {
    const store = await makeStore();
    const record = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    // Undefined, not zero. Zero is a real value and is the kill switch, so the two must never merge.
    expect(record.turnsPerDay).toBeUndefined();
    expect(record.mintsPerDay).toBeUndefined();
  });

  it('records an operator budget and reads it back through lookup', async () => {
    const store = await makeStore();
    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    const updated = await store.setBudget(
      created.embedId,
      { turnsPerDay: 50, mintsPerDay: 20 },
      now,
    );

    expect(updated).toMatchObject({ turnsPerDay: 50, mintsPerDay: 20 });
    expect(await store.lookup(created.embedId)).toMatchObject({ turnsPerDay: 50, mintsPerDay: 20 });
  });

  it('records the bridge budgets an operator sets, on both stores', async () => {
    const store = await makeStore();
    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    const updated = await store.setBudget(
      created.embedId,
      { bridgeToolCallsPerSession: 25, bridgeToolCallsPerDay: 900 },
      now,
    );

    // These shipped platform-only, so a surface could not be tuned for its own agent traffic without
    // a release. Round-tripping them is what makes the number operable rather than published.
    expect(updated).toMatchObject({ bridgeToolCallsPerSession: 25, bridgeToolCallsPerDay: 900 });
    expect(await store.lookup(created.embedId)).toMatchObject({
      bridgeToolCallsPerSession: 25,
      bridgeToolCallsPerDay: 900,
    });
  });

  it('leaves the bridge budgets alone when a turn cap is the only thing set', async () => {
    const store = await makeStore();
    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    await store.setBudget(created.embedId, { bridgeToolCallsPerDay: 900 }, now);
    const updated = await store.setBudget(created.embedId, { turnsPerDay: 50 }, now);

    expect(updated).toMatchObject({ turnsPerDay: 50, bridgeToolCallsPerDay: 900 });
  });

  it('changes only the cap it was given', async () => {
    const store = await makeStore();
    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    await store.setBudget(created.embedId, { turnsPerDay: 50, mintsPerDay: 20 }, now);
    const updated = await store.setBudget(created.embedId, { mintsPerDay: 5 }, now);

    expect(updated).toMatchObject({ turnsPerDay: 50, mintsPerDay: 5 });
  });

  it('stores zero as a value, because zero is the kill switch', async () => {
    const store = await makeStore();
    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    expect(await store.setBudget(created.embedId, { turnsPerDay: 0 }, now)).toMatchObject({
      turnsPerDay: 0,
    });
  });

  /**
   * The reason `ensure` is `DO NOTHING` rather than an upsert. An operator switches a surface off, the
   * team ships a routine deploy an hour later, and the switch must still be off.
   */
  it('survives a redeploy of the same surface', async () => {
    const store = await makeStore();
    const target = tenant();
    const created = await store.ensure({ ...target, surfaceMode: 'public', now });
    await store.setBudget(created.embedId, { turnsPerDay: 0 }, now);
    await store.ensure({ ...target, surfaceMode: 'public', now: new Date('2030-06-01T10:00:00Z') });

    expect(await store.lookup(created.embedId)).toMatchObject({ turnsPerDay: 0 });
  });

  it('reports nothing for a budget change against an unknown or revoked id', async () => {
    const store = await makeStore();
    expect(
      await store.setBudget('pub_doesnotexistdoesnotexist', { turnsPerDay: 1 }, now),
    ).toBeUndefined();

    const created = await store.ensure({ ...tenant(), surfaceMode: 'public', now });
    await store.revoke(created.embedId, now);
    expect(await store.setBudget(created.embedId, { turnsPerDay: 1 }, now)).toBeUndefined();
  });

  it('lists only live ids for a tenant', async () => {
    const store = await makeStore();
    const target = tenant();
    const live = await store.ensure({ ...target, surfaceMode: 'public', now });
    expect(await store.list(target)).toEqual([expect.objectContaining({ embedId: live.embedId })]);
    await store.revoke(live.embedId, now);
    expect(await store.list(target)).toEqual([]);
  });
}

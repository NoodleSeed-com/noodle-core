import { expect, it } from 'vitest';
import type { CapabilityPolicyStore } from '../src/policy-store.js';

export function policyStoreConformance(factory: () => Promise<CapabilityPolicyStore>) {
  it('isolates scope and uses compare-and-set with idempotent replay', async () => {
    const store = await factory();
    const scope = { org: 'acme', app: 'demo', env: 'staging', name: 'pages' };
    expect(await store.get(scope)).toBeUndefined();
    const update = {
      expectedRevision: 0,
      mutationId: 'first',
      actor: 'operator',
      policy: { enabled: true, maxUrls: 2, dailyCalls: 10 },
    };
    const first = await store.replace(scope, update);
    expect(first.revision).toBe(1);
    expect(await store.replace(scope, update)).toEqual(first);
    expect(await store.get({ ...scope, org: 'other' })).toBeUndefined();
    expect(await store.get({ ...scope, env: 'production' })).toBeUndefined();
    await expect(store.replace(scope, { ...update, mutationId: 'stale' })).rejects.toThrow(
      'capability_policy_conflict',
    );
    await expect(
      store.replace(scope, { ...update, policy: { enabled: false, dailyCalls: 10 } }),
    ).rejects.toThrow('capability_policy_conflict');
  });
  it('allows only one concurrent replacement of the same revision', async () => {
    const store = await factory();
    const scope = { org: 'concurrent', app: 'demo', env: 'staging', name: 'pages' };
    const updates = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        store.replace(scope, {
          expectedRevision: 0,
          mutationId: `mutation-${i}`,
          actor: 'operator',
          policy: { enabled: false, dailyCalls: 10 },
        }),
      ),
    );
    expect(updates.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect((await store.get(scope))?.revision).toBe(1);
  });
  it('rejects unknown configuration and invalid scope before persistence', async () => {
    const store = await factory();
    await expect(
      store.replace(
        { org: 'acme/other', app: 'demo', env: 'staging', name: 'pages' },
        {
          expectedRevision: 0,
          mutationId: 'first',
          actor: 'operator',
          policy: { enabled: true, dailyCalls: 10 },
        },
      ),
    ).rejects.toThrow();
  });
}

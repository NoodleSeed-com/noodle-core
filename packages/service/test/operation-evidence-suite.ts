import {
  digestMcpArguments,
  RequestStateManager,
  requestStateSecretBox,
} from '@noodle-borg/protocol';
import type { OperationEvidenceIntent } from '@noodle-borg/runtime';
import { describe, expect, it } from 'vitest';
import {
  createOperationEvidencePort,
  type OperationEvidenceOptions,
  type OperationEvidenceStore,
} from '../src/operation-evidence.js';

export function describeOperationEvidence(create: () => Promise<OperationEvidenceStore>): void {
  const scope = { org: 'a', app: 'site', env: 'production', installationId: 'site' };
  const start = 1_800_000_000_000;
  const intent: OperationEvidenceIntent = {
    id: 'operation-one',
    tool: 'submit',
    arguments: { email: 'private@example.test' },
    caller: { subject: 'private-caller' },
    operation: {
      resolved: true,
      connectorId: 'external',
      connectorVersion: '1',
      operation: 'submit',
      signatureHash: 'signature',
    },
  };
  function options(
    store: OperationEvidenceStore,
    overrides: Partial<OperationEvidenceOptions> = {},
  ): OperationEvidenceOptions {
    return {
      store,
      scope,
      epoch: 'test-restore-epoch-0001',
      identityKey: 'test-key-which-is-at-least-thirty-two-characters',
      deploymentId: 'release',
      now: () => start,
      authorize: async () => true,
      executionBoundMs: () => 10_000,
      historyDays: async () => 7,
      connectionGeneration: () => undefined,
      ...overrides,
    };
  }
  describe('durable operation evidence conformance', () => {
    it('projects one coordinated business attempt while retaining child custody and complete pagination', async () => {
      const store = await create();
      const port = createOperationEvidencePort(
        options(store, { connectionGeneration: () => 'generation-1' }),
      );
      const parent = await port.begin({ ...intent, id: 'a-parent', connectionId: 'account' });
      const childIntent = { ...intent, id: 'b-child', parentId: 'a-parent' };
      const child = await port.begin(childIntent);
      const next = await port.begin({ ...intent, id: 'c-next' });
      await child?.finish({ outcome: 'completed', reference: 'provider-child' });
      await parent?.finish({ outcome: 'unknown', reference: 'reviewed-business-operation' });
      await next?.finish({ outcome: 'rejected' });
      const first = await store.list(scope, start + 1, 7, 1);
      expect(first).toMatchObject([
        { id: 'a-parent', connectionId: 'account', generation: 'generation-1', outcome: 'unknown' },
      ]);
      const cursor = { id: first[0]?.id ?? '', startedAt: start };
      expect(await store.list(scope, start + 1, 7, 1, cursor)).toMatchObject([{ id: 'c-next' }]);
      expect(await port.begin(childIntent)).toBeUndefined();
      await expect(child?.finish({ outcome: 'rejected' })).rejects.toThrow();
      expect(
        await store.preview(scope, {
          asOf: start + 1,
          paidPeriodEnd: start + 86_400_000,
          currentMaximumDays: 7,
          scenarios: [{ id: 'lower', maximumDays: 1 }],
        }),
      ).toMatchObject({ currentlyAccessibleCount: 2 });
      const foreignScope = { ...scope, installationId: 'foreign' };
      expect(await store.list(foreignScope, start + 1, 7, 100)).toEqual([]);
      const foreign = await createOperationEvidencePort(
        options(store, { scope: foreignScope }),
      ).begin({ ...intent, id: 'b-child' });
      expect(foreign).toBeDefined();
      expect(await store.list(foreignScope, start + 1, 7, 100)).toMatchObject([{ id: 'b-child' }]);
    });
    it('sweeps hidden child dispatches without making them visible or retryable', async () => {
      const store = await create();
      const port = createOperationEvidencePort(options(store));
      const parent = await port.begin({ ...intent, id: 'parent' });
      const childIntent = { ...intent, id: 'child', parentId: 'parent' };
      const child = await port.begin(childIntent);
      await parent?.finish({ outcome: 'unknown' });
      await store.sweep(start + 10_001);
      await expect(child?.finish({ outcome: 'completed' })).rejects.toThrow();
      expect(await port.begin(childIntent)).toBeUndefined();
      expect(await store.list(scope, start + 10_001, 7, 100)).toMatchObject([
        { id: 'parent', outcome: 'unknown' },
      ]);
      expect(
        await store.preview(scope, {
          asOf: start + 10_001,
          paidPeriodEnd: start + 86_400_000,
          currentMaximumDays: 7,
          scenarios: [{ id: 'lower', maximumDays: 1 }],
        }),
      ).toMatchObject({ currentlyAccessibleCount: 1 });
    });
    it('previews only currently accessible history and separates physical expiry from additional access loss', async () => {
      const store = await create();
      const day = 86_400_000;
      const now = start + 100 * day;
      const periodEnd = now + 10 * day;
      const add = async (id: string, age: number, retention: number, targetScope = scope) => {
        const at = now - age * day;
        const port = createOperationEvidencePort(
          options(store, {
            scope: targetScope,
            now: () => at,
            historyDays: async () => retention,
          }),
        );
        const claim = await port.begin({ ...intent, id });
        expect(claim).toBeDefined();
        await claim?.finish({ outcome: 'completed', reference: 'private-provider-reference' });
      };
      await add('additional-loss', 40, 90);
      await add('expires-exactly-at-period-end', 20, 30);
      await add('already-expired', 20, 7);
      await add('already-hidden-by-current-window', 100, 365);
      await add('naturally-ages-out-of-current-window', 85, 180);
      await add('exact-lower-boundary', 20, 90);
      await add('recent', 1, 90);
      await add('other-installation', 40, 90, { ...scope, installationId: 'other' });
      const preview = await store.preview(scope, {
        asOf: now,
        paidPeriodEnd: periodEnd,
        currentMaximumDays: 90,
        scenarios: [{ id: 'lower', maximumDays: 30 }],
      });
      expect(preview).toEqual({
        currentlyAccessibleCount: 5,
        physicallyExpiresByPeriodEndCount: 1,
        scenarios: [{ id: 'lower', additionallyHiddenAtPeriodEndCount: 1 }],
      });
      expect(
        await store.preview(scope, {
          asOf: now,
          paidPeriodEnd: now + 365 * day,
          currentMaximumDays: 90,
          scenarios: [{ id: 'lower', maximumDays: 30 }],
        }),
      ).toEqual({
        currentlyAccessibleCount: 5,
        physicallyExpiresByPeriodEndCount: 5,
        scenarios: [{ id: 'lower', additionallyHiddenAtPeriodEndCount: 0 }],
      });
      expect(JSON.stringify(preview)).not.toContain('private-provider-reference');
      expect(await store.readRetention(scope)).toBeUndefined();
      expect(
        (await store.list(scope, now, 365, 100)).some(
          (row) => row.reference === 'private-provider-reference',
        ),
      ).toBe(true);
    });
    it('previews expired dispatch as unknown without treating a running operation as terminal', async () => {
      const store = await create();
      await createOperationEvidencePort(options(store)).begin({ ...intent, id: 'timeout' });
      const asOf = start + 20_000;
      await createOperationEvidencePort(options(store, { now: () => asOf })).begin({
        ...intent,
        id: 'active',
      });
      expect(
        await store.preview(scope, {
          asOf,
          paidPeriodEnd: asOf + 3 * 86_400_000,
          currentMaximumDays: 7,
          scenarios: [{ id: 'lower', maximumDays: 1 }],
        }),
      ).toEqual({
        currentlyAccessibleCount: 1,
        physicallyExpiresByPeriodEndCount: 0,
        scenarios: [{ id: 'lower', additionallyHiddenAtPeriodEndCount: 1 }],
      });
    });
    it('claims once under concurrency and keeps only keyed digests of private intent', async () => {
      const store = await create();
      const port = createOperationEvidencePort(options(store));
      const claims = await Promise.all(Array.from({ length: 8 }, () => port.begin(intent)));
      expect(claims.filter(Boolean)).toHaveLength(1);
      await claims.find(Boolean)?.finish({ outcome: 'accepted', reference: 'job-42' });
      const records = await store.list(scope, start + 1, 7, 100);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ outcome: 'accepted', reference: 'job-42' });
      expect(JSON.stringify(records)).not.toContain('private@example.test');
      expect(JSON.stringify(records)).not.toContain('private-caller');
    });
    it('denies tenant/lease/epoch confusion and terminal overwrite', async () => {
      const store = await create();
      await createOperationEvidencePort(options(store)).begin(intent);
      const record = (await store.list(scope, start + 1, 7, 100))[0];
      if (!record) throw new Error('Missing claimed evidence');
      expect(
        await store.finish(
          { ...scope, org: 'other' },
          record.id,
          record.lease,
          record.epoch,
          { outcome: 'completed' },
          start + 1,
        ),
      ).toBe(false);
      expect(
        await store.finish(
          scope,
          record.id,
          'wrong',
          record.epoch,
          { outcome: 'completed' },
          start + 1,
        ),
      ).toBe(false);
      expect(
        await store.finish(
          scope,
          record.id,
          record.lease,
          'old-epoch',
          { outcome: 'completed' },
          start + 1,
        ),
      ).toBe(false);
      expect(
        await store.finish(
          scope,
          record.id,
          record.lease,
          record.epoch,
          { outcome: 'completed' },
          start + 1,
        ),
      ).toBe(true);
      expect(
        await store.finish(
          scope,
          record.id,
          record.lease,
          record.epoch,
          { outcome: 'rejected' },
          start + 2,
        ),
      ).toBe(false);
    });
    it('expires active claims to unknown and cannot turn a late response into a new write', async () => {
      const store = await create();
      const port = createOperationEvidencePort(options(store));
      const claimed = await port.begin(intent);
      await store.sweep(start + 10_000);
      expect((await store.list(scope, start + 10_001, 7, 100))[0]?.outcome).toBe('unknown');
      await expect(claimed?.finish({ outcome: 'completed' })).rejects.toThrow();
      expect(await port.begin(intent)).toBeUndefined();
    });
    it.each([
      'completed',
      'rejected',
      'accepted',
      'unknown',
      'returned',
    ] as const)('applies ordinary browsing and finite expiry to terminal dispatch outcome %s', async (outcome) => {
      const store = await create();
      const claim = await createOperationEvidencePort(options(store)).begin(intent);
      await claim?.finish({ outcome });
      expect(await store.list(scope, start + 2 * 86_400_000, 1, 100)).toEqual([]);
      expect(await store.list(scope, start + 2 * 86_400_000, 7, 100)).toHaveLength(1);
      expect((await store.list(scope, start + 2 * 86_400_000, 7, 100))[0]?.outcome).toBe(outcome);
      await expect(claim?.finish({ outcome: 'completed' })).rejects.toThrow();
      await store.sweep(start + 7 * 86_400_000);
      expect(await store.list(scope, start + 7 * 86_400_000, 365, 100)).toEqual([]);
    });
    it('keeps equal-time pagination complete without exempting timed-out dispatch from paid windows', async () => {
      const store = await create();
      const port = createOperationEvidencePort(options(store));
      for (const id of ['a', 'b', 'c']) await port.begin({ ...intent, id });
      expect(await store.list(scope, start + 2 * 86_400_000, 1, 2)).toEqual([]);
      const page = await store.list(scope, start + 2 * 86_400_000, 7, 2);
      expect(page.map((row) => row.id)).toEqual(['a', 'b']);
      const last = page.at(-1);
      expect(
        await store.list(
          scope,
          start + 2 * 86_400_000,
          7,
          2,
          last && { id: last.id, startedAt: last.startedAt },
        ),
      ).toMatchObject([{ id: 'c' }]);
    });
    it('starts timeout history at the dispatch deadline once, even when the sweep is delayed', async () => {
      const store = await create();
      const port = createOperationEvidencePort(options(store, { historyDays: async () => 1 }));
      const claim = await port.begin(intent);
      const deadline = start + 10_000;
      expect((await store.list(scope, deadline - 1, 1, 100))[0]?.outcome).toBe('dispatching');
      const originalExpiry = start + 86_400_000;
      const records = await store.list(scope, originalExpiry, 1, 100);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        outcome: 'unknown',
        completedAt: deadline,
        historyExpiresAt: deadline + 86_400_000,
      });
      await store.sweep(originalExpiry + 1);
      expect((await store.list(scope, originalExpiry + 1, 1, 100))[0]?.historyExpiresAt).toBe(
        deadline + 86_400_000,
      );
      expect(await port.begin(intent)).toBeUndefined();
      expect(await store.list(scope, deadline + 86_400_000, 365, 100)).toEqual([]);
      await expect(claim?.finish({ outcome: 'completed' })).rejects.toThrow();
    });
    it('assigns completion expiry under the current retention setting and never rewrites it', async () => {
      const store = await create();
      let now = start;
      let days = 30;
      const claim = await createOperationEvidencePort(
        options(store, { now: () => now, historyDays: async () => days }),
      ).begin(intent);
      now += 1000;
      days = 7;
      await claim?.finish({ outcome: 'completed' });
      const record = (await store.list(scope, now, 7, 100))[0];
      expect(record?.historyExpiresAt).toBe(now + 7 * 86_400_000);
      expect(await store.list(scope, now + 7 * 86_400_000, 365, 100)).toEqual([]);
    });
    it('cannot resurrect sealed invocation authority after its Activity evidence expires', async () => {
      const store = await create();
      let now = start;
      const state = new RequestStateManager(requestStateSecretBox(Buffer.alloc(32, 19)), {
        now: () => now,
      });
      const binding = {
        deploymentId: 'release',
        serverVersion: '1',
        method: 'tools/call' as const,
        target: intent.tool,
        principal: 'caller',
        argumentDigest: digestMcpArguments(intent.arguments),
      };
      const token = await state.seal({
        binding,
        responses: {},
        round: 1,
        expiresAt: start + 5 * 60_000,
        nonce: intent.id,
        confirmation: true,
        pendingRequest: { id: 'confirm', interaction: 'confirmation' },
      });
      expect((await state.open(token, binding)).nonce).toBe(intent.id);
      const claim = await createOperationEvidencePort(
        options(store, { historyDays: async () => 1 }),
      ).begin(intent);
      await claim?.finish({ outcome: 'unknown' });
      now = start + 86_400_000;
      expect(await store.list(scope, now, 365, 100)).toEqual([]);
      await expect(state.open(token, binding)).rejects.toMatchObject({
        reason: 'request_state_expired',
      });
      await expect(claim?.finish({ outcome: 'completed' })).rejects.toThrow();
    });
    it('uses scoped atomic setting revisions and does not let stale callers overwrite them', async () => {
      const store = await create();
      expect(await store.setRetention(scope, 7, undefined)).toBe(true);
      expect(await store.setRetention(scope, 30, undefined)).toBe(false);
      expect(await store.readRetention({ ...scope, org: 'elsewhere' })).toBeUndefined();
      expect(await store.setRetention(scope, 3, 1)).toBe(true);
      expect(await store.setRetention(scope, 4, 1)).toBe(false);
      expect(await store.readRetention(scope)).toEqual({ days: 3, revision: 2 });
    });
    it('fails before a claim for missing authority or unbounded execution', async () => {
      const store = await create();
      for (const override of [
        { authorize: async () => false },
        { executionBoundMs: () => undefined },
      ]) {
        await expect(
          createOperationEvidencePort(options(store, override)).begin(intent),
        ).rejects.toThrow();
      }
      expect(await store.list(scope, start + 1, 7, 100)).toEqual([]);
    });
  });
}

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { BusinessInformationStore } from '../src/business-information/contracts.js';

const DAY = 86_400_000;
export function describeNativeRecordLifecycle(
  make: () => Promise<{ store: BusinessInformationStore; advance: (milliseconds: number) => void }>,
) {
  async function fixture() {
    const harness = await make();
    const scope = {
      org: `lifecycle-${randomUUID()}`,
      app: 'site',
      env: 'prod',
      installationId: 'site',
    };
    const { store } = harness;
    await store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      retentionDays: 7,
      actorSubject: 'owner',
    });
    const create = async (idempotencyKey: string) => {
      const result = await store.createRequest({
        scope,
        collectionKey: 'travel_requests',
        idempotencyKey,
        payload: { request_type: 'information', summary: 'Private customer request' },
        origin: { kind: 'portal' },
        actorSubject: 'owner',
      });
      if (result.disposition !== 'created') throw new Error('expected new record');
      return result.record;
    };
    const preview = () => store.nativeLifecycle.preview(scope, 'owner');
    const migrate = async () =>
      store.nativeLifecycle.migrate({ scope, actor: 'owner', preview: await preview() });
    return { ...harness, scope, create, preview, migrate };
  }
  it('keeps the legacy policy until explicit reviewed migration, then preserves active records and new writes', async () => {
    const f = await fixture();
    const original = await f.create('original');
    const before = await f.preview();
    expect(before).toMatchObject({
      policy: 'legacy_expiry',
      recordsToPreserve: 1,
      expiredRecords: 0,
    });
    expect(JSON.stringify(before)).not.toContain('Private customer request');
    const applied = await f.store.nativeLifecycle.migrate({
      scope: f.scope,
      actor: 'owner',
      preview: before,
    });
    expect(applied).toMatchObject({
      policy: 'explicit_erasure',
      recordsPreserved: 1,
      replayed: false,
    });
    expect(
      await f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview: before }),
    ).toMatchObject({ replayed: true });
    await expect(
      f.store.nativeLifecycle.migrate({
        scope: f.scope,
        actor: 'owner',
        preview: { ...before, recordsToPreserve: 1234 },
      }),
    ).rejects.toThrow('lifecycle_conflict');
    const next = await f.create('after-migration');
    expect(next.retentionExpiresAt).toBeNull();
    f.advance(365 * DAY);
    expect(await f.store.purgeExpired({ scope: f.scope })).toBe(0);
    const record = await f.store.getRequest(f.scope, 'travel_requests', original.id);
    if (!record) throw new Error('preserved record missing');
    expect(record).toMatchObject({ retentionExpiresAt: null, content: original.content });
    expect(
      (await f.store.listRequests({ scope: f.scope, collectionKey: 'travel_requests' })).records,
    ).toHaveLength(2);
    expect(
      (await f.store.exportRequests({ scope: f.scope, collectionKey: 'travel_requests' })).records,
    ).toHaveLength(2);
    expect(
      await f.store.mutateRequest({
        scope: f.scope,
        collectionKey: 'travel_requests',
        id: original.id,
        expectedRevision: record.revision,
        actorSubject: 'owner',
        operation: { kind: 'add_note', note: 'Still active' },
      }),
    ).toMatchObject({ ok: true });
    const current = await f.store.getRequest(f.scope, 'travel_requests', original.id);
    if (!current) throw new Error('updated record missing');
    expect(
      await f.store.deleteRequest({
        scope: f.scope,
        collectionKey: 'travel_requests',
        id: original.id,
        expectedRevision: current.revision,
        actorSubject: 'owner',
        reason: 'customer_request',
      }),
    ).toMatchObject({ ok: true });
    expect(await f.store.getRequest(f.scope, 'travel_requests', original.id)).toBeUndefined();
  });
  it('never revives content already expired or explicitly erased, even before the sweep runs', async () => {
    const f = await fixture();
    const expired = await f.create('expired');
    const erased = await f.create('erased');
    await f.store.deleteRequest({
      scope: f.scope,
      collectionKey: 'travel_requests',
      id: erased.id,
      expectedRevision: erased.revision,
      actorSubject: 'owner',
      reason: 'customer_request',
    });
    f.advance(7 * DAY);
    const active = await f.create('active');
    expect(await f.preview()).toMatchObject({ recordsToPreserve: 1, expiredRecords: 1 });
    await f.migrate();
    expect(await f.store.getRequest(f.scope, 'travel_requests', expired.id)).toBeUndefined();
    expect(await f.store.getRequest(f.scope, 'travel_requests', erased.id)).toBeUndefined();
    f.advance(10 * DAY);
    expect(await f.store.getRequest(f.scope, 'travel_requests', active.id)).toMatchObject({
      retentionExpiresAt: null,
    });
  });
  it('rejects stale inventory, installation revision, expired previews, and forged or cross-scope evidence', async () => {
    const f = await fixture();
    const before = await f.preview();
    await f.create('after-review');
    await expect(
      f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview: before }),
    ).rejects.toThrow('lifecycle_conflict');
    const latest = await f.preview();
    const other = await fixture();
    await expect(
      other.store.nativeLifecycle.migrate({ scope: other.scope, actor: 'owner', preview: latest }),
    ).rejects.toThrow('lifecycle_conflict');
    await expect(
      f.store.nativeLifecycle.migrate({
        scope: f.scope,
        actor: 'owner',
        preview: { ...latest, digest: 'a'.repeat(64) },
      }),
    ).rejects.toThrow('lifecycle_conflict');
    f.advance(5 * 60_000 + 1);
    await expect(
      f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview: latest }),
    ).rejects.toThrow('lifecycle_conflict');
    expect((await f.preview()).policy).toBe('legacy_expiry');
  });
  it('invalidates reviews when installation state, record contents or expiry classification changes', async () => {
    const f = await fixture();
    const record = await f.create('mutable');
    const installationPreview = await f.preview();
    await f.store.setIntakeState({
      scope: f.scope,
      actorSubject: 'owner',
      active: false,
      expectedRevision: installationPreview.installationRevision,
    });
    await expect(
      f.store.nativeLifecycle.migrate({
        scope: f.scope,
        actor: 'owner',
        preview: installationPreview,
      }),
    ).rejects.toThrow('lifecycle_conflict');
    const contentPreview = await f.preview();
    await f.store.mutateRequest({
      scope: f.scope,
      collectionKey: 'travel_requests',
      id: record.id,
      actorSubject: 'owner',
      expectedRevision: record.revision,
      operation: { kind: 'add_note', note: 'Updated' },
    });
    await expect(
      f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview: contentPreview }),
    ).rejects.toThrow('lifecycle_conflict');
    f.advance(7 * DAY - 1);
    const expiring = await f.preview();
    f.advance(1);
    await expect(
      f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview: expiring }),
    ).rejects.toThrow('lifecycle_conflict');
    expect((await f.preview()).recordsToPreserve).toBe(0);
  });
  it('requires current administration for preview, apply and exact replay', async () => {
    const f = await fixture();
    const preview = await f.preview();
    for (const role of ['manager', 'operator', 'viewer'] as const) {
      await f.store.setGrant({
        scope: f.scope,
        subject: role,
        email: `${role}@example.test`,
        role,
        expectedRevision: 0,
        actorSubject: 'owner',
      });
      await expect(f.store.nativeLifecycle.preview(f.scope, role)).rejects.toThrow(
        'lifecycle_denied',
      );
      await expect(
        f.store.nativeLifecycle.migrate({ scope: f.scope, actor: role, preview }),
      ).rejects.toThrow('lifecycle_denied');
    }
    await f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'owner', preview });
    await expect(
      f.store.nativeLifecycle.migrate({ scope: f.scope, actor: 'stranger', preview }),
    ).rejects.toThrow('lifecycle_denied');
  });
}

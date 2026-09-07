import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  BusinessInformationStore,
  InstallationScope,
  ManagedRequestRecord,
} from '../src/business-information/contracts.js';

export interface StoreHarness {
  readonly store: BusinessInformationStore;
  readonly advance: (milliseconds: number) => void;
}

export function describeBusinessInformationStore(makeHarness: () => Promise<StoreHarness>): void {
  const uniqueScope = (suffix = randomUUID()): InstallationScope => ({
    org: `org-${suffix}`,
    app: 'operations',
    env: 'prod',
    installationId: `install-${suffix}`,
  });

  async function install(harness: StoreHarness, scope = uniqueScope()) {
    const result = await harness.store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      retentionDays: 30,
      actorSubject: 'founder',
    });
    expect(result.disposition).toBe('created');
    return { scope, installation: result.installation };
  }

  async function createRequest(
    harness: StoreHarness,
    scope: InstallationScope,
    suffix = randomUUID(),
  ): Promise<ManagedRequestRecord> {
    const result = await harness.store.createRequest({
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: `request-${suffix}`,
      payload: {
        request_type: 'refund',
        summary: `Review refund ${suffix}`,
        booking_reference: 'ABC123',
      },
      origin: { kind: 'embedded', reference: 'booking-page' },
      actorSubject: 'traveler-1',
    });
    expect(result.disposition).toBe('created');
    return result.record;
  }

  it('creates an opt-in installation idempotently and an independent administrator grant', async () => {
    const harness = await makeHarness();
    const scope = uniqueScope();
    const input = {
      scope,
      profileKey: 'travel' as const,
      managedCollections: ['travel_requests'] as const,
      retentionDays: 30 as const,
      actorSubject: 'founder',
      actorEmail: 'Founder@Example.com',
    };
    const created = await harness.store.createInstallation(input);
    const replay = await harness.store.createInstallation(input);
    expect(created).toMatchObject({
      disposition: 'created',
      installation: {
        scope,
        publicId: expect.stringMatching(/^sol_/),
        retentionDays: 30,
        revision: 1,
      },
    });
    expect(replay).toMatchObject({ disposition: 'replayed', installation: created.installation });
    await expect(
      harness.store.createInstallation({ ...input, retentionDays: 90 }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
    await expect(harness.store.getGrant(scope, 'founder')).resolves.toMatchObject({
      email: 'founder@example.com',
      role: 'administrator',
      revision: 1,
    });
    await expect(
      harness.store.getInstallationById(scope.org, scope.installationId),
    ).resolves.toEqual(created.installation);
    await expect(
      harness.store.resolveInstallationByPublicId(created.installation.publicId),
    ).resolves.toEqual(created.installation);
    await expect(harness.store.listInstallations(scope.org)).resolves.toEqual([
      created.installation,
    ]);
  });

  it('keeps business grants installation-scoped and uses CAS for role changes and revocation', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const other = (await install(harness, uniqueScope())).scope;
    await expect(
      harness.store.setGrant({
        scope: uniqueScope(),
        subject: 'agent-1',
        email: 'agent-1@example.com',
        role: 'operator',
        expectedRevision: 0,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not_found', currentRevision: 0 });
    const granted = await harness.store.setGrant({
      scope,
      subject: 'agent-1',
      email: 'agent-1@example.com',
      role: 'operator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    expect(granted).toMatchObject({
      ok: true,
      grant: { email: 'agent-1@example.com', role: 'operator', revision: 1 },
    });
    await expect(harness.store.getGrant(other, 'agent-1')).resolves.toBeUndefined();
    await expect(
      harness.store.setGrant({
        scope,
        subject: 'agent-1',
        email: 'agent-1@example.com',
        role: 'manager',
        expectedRevision: 0,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'conflict', currentRevision: 1 });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'agent-1',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toMatchObject({ ok: true, grant: { revision: 2, revokedAt: expect.any(String) } });
  });

  it('preserves at least one live installation administrator', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    await expect(
      harness.store.setGrant({
        scope,
        subject: 'founder',
        email: 'founder@example.com',
        role: 'manager',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'last_administrator', currentRevision: 1 });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'founder',
        expectedRevision: 1,
        actorSubject: 'founder',
      }),
    ).resolves.toEqual({ ok: false, reason: 'last_administrator', currentRevision: 1 });
    await harness.store.setGrant({
      scope,
      subject: 'admin-2',
      email: 'admin-2@example.com',
      role: 'administrator',
      expectedRevision: 0,
      actorSubject: 'founder',
    });
    await expect(
      harness.store.revokeGrant({
        scope,
        subject: 'founder',
        expectedRevision: 1,
        actorSubject: 'admin-2',
      }),
    ).resolves.toMatchObject({ ok: true, grant: { revokedAt: expect.any(String) } });
  });

  it('creates requests idempotently, isolates installations, and returns defensive records', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const other = (await install(harness, uniqueScope())).scope;
    const input = {
      scope,
      collectionKey: 'travel_requests',
      idempotencyKey: 'intake-1',
      payload: { request_type: 'service', summary: 'Change the passenger meal.' },
      origin: { kind: 'mcp' as const, reference: 'call-1' },
      actorSubject: 'traveler-1',
    };
    const created = await harness.store.createRequest(input);
    const replay = await harness.store.createRequest(input);
    expect(created).toMatchObject({
      disposition: 'created',
      record: { revision: 1, status: 'new' },
    });
    expect(replay).toMatchObject({ disposition: 'replayed', record: created.record });
    await expect(
      harness.store.createRequest({
        ...input,
        payload: { ...input.payload, summary: 'Changed retry' },
      }),
    ).resolves.toMatchObject({ disposition: 'conflict' });
    await expect(
      harness.store.getRequest(other, 'travel_requests', created.record.id),
    ).resolves.toBeUndefined();
    const read = await harness.store.getRequest(scope, 'travel_requests', created.record.id);
    if (read?.content) (read.content.payload as { summary: string }).summary = 'outside mutation';
    await expect(
      harness.store.getRequest(scope, 'travel_requests', created.record.id),
    ).resolves.toMatchObject({
      content: { payload: { summary: 'Change the passenger meal.' } },
    });

    await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: {
        kind: 'update',
        payload: { request_type: 'service', summary: 'Updated after initial receipt.' },
      },
    });
    await expect(harness.store.createRequest(input)).resolves.toMatchObject({
      disposition: 'replayed',
      record: { id: created.record.id, revision: 2, status: 'new' },
    });
  });

  it('applies update, assignment, status, and note operations through one CAS history', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    const updated = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'manager-1',
      operation: {
        kind: 'update',
        payload: { request_type: 'refund', summary: 'Corrected refund request.' },
      },
    });
    expect(updated).toMatchObject({ ok: true, record: { revision: 2 } });
    const assigned = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 2,
      actorSubject: 'manager-1',
      operation: { kind: 'assign', assigneeSubject: 'operator-1' },
    });
    expect(assigned).toMatchObject({
      ok: true,
      record: { revision: 3, assigneeSubject: 'operator-1' },
    });
    const status = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 3,
      actorSubject: 'operator-1',
      operation: { kind: 'set_status', status: 'in_progress' },
    });
    expect(status).toMatchObject({ ok: true, record: { revision: 4, status: 'in_progress' } });
    const noted = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 4,
      actorSubject: 'operator-1',
      operation: { kind: 'add_note', note: 'Customer confirmed the original payment method.' },
    });
    expect(noted).toMatchObject({
      ok: true,
      record: { revision: 5, content: { notes: [{ text: expect.stringContaining('confirmed') }] } },
    });
    await expect(
      harness.store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.id,
        expectedRevision: 1,
        actorSubject: 'stale',
        operation: { kind: 'assign', assigneeSubject: undefined },
      }),
    ).resolves.toEqual({ ok: false, reason: 'conflict', currentRevision: 5 });
    await expect(
      harness.store.listActivity(scope, 'travel_requests', created.id),
    ).resolves.toMatchObject([
      { revision: 1, kind: 'created' },
      { revision: 2, kind: 'updated' },
      { revision: 3, kind: 'assigned' },
      { revision: 4, kind: 'status_changed' },
      { revision: 5, kind: 'note_added' },
    ]);
  });

  it('enforces bounded status transitions', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    const closed = await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: { kind: 'set_status', status: 'closed' },
    });
    expect(closed).toMatchObject({ ok: true, record: { status: 'closed' } });
    await expect(
      harness.store.mutateRequest({
        scope,
        collectionKey: 'travel_requests',
        id: created.id,
        expectedRevision: 2,
        actorSubject: 'operator-1',
        operation: { kind: 'set_status', status: 'new' },
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_transition', currentRevision: 2 });
  });

  it('lists and exports bounded pages with stable cursors', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const first = await createRequest(harness, scope, 'first');
    const second = await createRequest(harness, scope, 'second');
    const listed = await harness.store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
    });
    expect(listed.records).toHaveLength(1);
    expect(listed.nextCursor).toBeDefined();
    const next = await harness.store.listRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
      cursor: listed.nextCursor,
    });
    expect(new Set([...listed.records, ...next.records].map((record) => record.id))).toEqual(
      new Set([first.id, second.id]),
    );
    const exported = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 1,
    });
    expect(exported.records).toHaveLength(1);
    expect(exported.snapshotAt).toBeDefined();
    const exportedNext = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      limit: 10,
      cursor: exported.nextCursor,
    });
    expect(exportedNext.snapshotAt).toBe(exported.snapshotAt);
    expect([...exported.records, ...exportedNext.records]).toHaveLength(2);
    await expect(
      harness.store.listRequests({
        scope,
        collectionKey: 'travel_requests',
        limit: 101,
      }),
    ).rejects.toThrow(/between 1 and 100/);
    await expect(
      harness.store.exportRequests({
        scope,
        collectionKey: 'travel_requests',
        limit: 500,
      }),
    ).resolves.toMatchObject({ records: expect.any(Array) });
  });

  it('soft-deletes by CAS and erases current and historical content', async () => {
    const harness = await makeHarness();
    const { scope } = await install(harness);
    const created = await createRequest(harness, scope);
    await harness.store.mutateRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 1,
      actorSubject: 'operator-1',
      operation: { kind: 'add_note', note: 'Erase this note during deletion.' },
    });
    const removed = await harness.store.deleteRequest({
      scope,
      collectionKey: 'travel_requests',
      id: created.id,
      expectedRevision: 2,
      actorSubject: 'manager-1',
      reason: 'customer_request',
    });
    expect(removed).toMatchObject({
      ok: true,
      record: { revision: 3, deletedAt: expect.any(String) },
    });
    if (removed.ok) expect(removed.record).not.toHaveProperty('content');
    await expect(
      harness.store.getRequest(scope, 'travel_requests', created.id),
    ).resolves.toBeUndefined();
    const tombstone = await harness.store.getRequest(scope, 'travel_requests', created.id, {
      includeDeleted: true,
    });
    expect(tombstone?.content).toBeUndefined();
    const activity = await harness.store.listActivity(scope, 'travel_requests', created.id);
    expect(activity).toHaveLength(3);
    expect(activity.every((entry) => entry.content === undefined)).toBe(true);
    const exported = await harness.store.exportRequests({
      scope,
      collectionKey: 'travel_requests',
      includeDeleted: true,
    });
    expect(exported.records[0]).toMatchObject({ id: created.id });
    expect(exported.records[0]).not.toHaveProperty('content');
  });

  it('expires content at the installation retention boundary', async () => {
    const harness = await makeHarness();
    const scope = uniqueScope();
    await harness.store.createInstallation({
      scope,
      profileKey: 'travel',
      managedCollections: ['travel_requests'],
      retentionDays: 7,
      actorSubject: 'founder',
    });
    const created = await createRequest(harness, scope);
    harness.advance(8 * 24 * 60 * 60 * 1000);
    await expect(harness.store.purgeExpired({ scope, limit: 10 })).resolves.toBe(1);
    await expect(
      harness.store.getRequest(scope, 'travel_requests', created.id, { includeDeleted: true }),
    ).resolves.toMatchObject({ deletedAt: expect.any(String) });
  });
}

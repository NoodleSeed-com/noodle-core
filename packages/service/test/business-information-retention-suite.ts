import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type {
  BusinessInformationStore,
  InstalledCollectionDefinition,
  JsonObject,
  ManagedRequestOperation,
  ManagedRequestRecord,
  SolutionDefinitionSnapshot,
} from '../src/business-information/contracts.js';
import type { StoreHarness } from './business-information-store-suite.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export function describeNativeRecordRetention(makeHarness: () => Promise<StoreHarness>): void {
  it.each([
    'get',
    'history',
    'list',
    'export',
    'duplicate',
    'probe',
    'mutation',
  ] as const)('blocks expired content when %s is the first access after expiry', async (entryPoint) => {
    const { store, advance } = await makeHarness();
    const scope = {
      org: `retention-first-access-${randomUUID()}`,
      app: 'records',
      env: 'prod',
      installationId: 'records',
    };
    expect(
      await store.createInstallation({
        scope,
        definition: retentionDefinition(),
        managedCollections: ['work'],
        retentionDays: 7,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ disposition: 'created' });
    const input = {
      scope,
      collectionKey: 'work',
      idempotencyKey: 'first-access',
      payload: { label: 'Original private content', stage: 'open' },
      origin: { kind: 'embedded' as const },
      actorSubject: 'visitor',
    };
    const created = await store.createRequest(input);
    if (created.disposition !== 'created') throw new Error('first-access record was not created');
    const noted = await store.mutateRequest({
      scope,
      collectionKey: 'work',
      id: created.record.id,
      expectedRevision: created.record.revision,
      actorSubject: 'owner',
      operation: { kind: 'add_note', note: 'Private historical content' },
    });
    if (!noted.ok) throw new Error('first-access note was not created');
    const record = noted.record;
    expect(record.content?.notes[0]?.text).toBe('Private historical content');

    // Each case owns fresh state. No access or sweep can erase it before this entry point.
    advance(7 * DAY_MS);
    switch (entryPoint) {
      case 'get':
        expect(await store.getRequest(scope, 'work', record.id)).toBeUndefined();
        break;
      case 'history': {
        const history = await store.listActivity(scope, 'work', record.id);
        expect(history.activities.length).toBeGreaterThan(0);
        expect(history.activities.every((event) => event.content === undefined)).toBe(true);
        break;
      }
      case 'list':
        expect(await store.listRequests({ scope, collectionKey: 'work' })).toMatchObject({
          records: [],
        });
        break;
      case 'export':
        expect(await store.exportRequests({ scope, collectionKey: 'work' })).toMatchObject({
          records: [],
        });
        break;
      case 'duplicate':
      case 'probe': {
        const replay =
          entryPoint === 'duplicate'
            ? await store.createRequest(input)
            : await store.probeRequest(input);
        expect(replay).toMatchObject({
          disposition: 'replayed',
          record: { id: record.id, deletionReason: 'retention_expired' },
        });
        if (replay.disposition !== 'replayed') throw new Error('expired receipt was not retained');
        expect(replay.record).not.toHaveProperty('content');
        break;
      }
      case 'mutation':
        expect(
          await store.mutateRequest({
            scope,
            collectionKey: 'work',
            id: record.id,
            expectedRevision: record.revision,
            actorSubject: 'owner',
            operation: { kind: 'update', payload: { label: 'Must not revive content' } },
          }),
        ).toMatchObject({ ok: false, reason: 'not_found' });
    }
    await expectExpired(store, record);
  });

  it.each([
    7, 30, 90,
  ] as const)('enforces %i-day creation-based expiry at the exact boundary without waiting for a sweep', async (retentionDays) => {
    const { store, advance } = await makeHarness();
    const scope = {
      org: `retention-${randomUUID()}`,
      app: 'records',
      env: 'prod',
      installationId: 'records',
    };
    const installationInput = {
      scope,
      definition: retentionDefinition(),
      managedCollections: ['items', 'work'],
      retentionDays,
      actorSubject: 'owner',
    };
    expect(await store.createInstallation(installationInput)).toMatchObject({
      disposition: 'created',
      installation: { retentionDays },
    });
    expect(
      await store.setGrant({
        scope,
        subject: 'operator',
        email: 'operator@example.test',
        role: 'operator',
        expectedRevision: 0,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
    const fixtures = [];
    for (const stage of [undefined, 'open', 'resolved', 'awaiting_supplier']) {
      const input = {
        scope,
        collectionKey: stage === undefined ? 'items' : 'work',
        idempotencyKey: stage ?? 'without-status',
        payload: { label: 'Original content', ...(stage === undefined ? {} : { stage }) },
        origin: { kind: 'embedded' as const },
        actorSubject: 'visitor',
      };
      const result = await store.createRequest(input);
      if (result.disposition !== 'created') throw new Error('retention fixture was not created');
      const record = result.record;
      expect(Date.parse(record.retentionExpiresAt) - Date.parse(record.createdAt)).toBe(
        retentionDays * DAY_MS,
      );
      fixtures.push({ input, record });
    }

    advance(retentionDays * DAY_MS - 1);
    for (const fixture of fixtures) {
      let record = fixture.record;
      const operations: ManagedRequestOperation[] = [
        { kind: 'update', payload: { label: 'Corrected just before expiry' } },
      ];
      if (record.collectionKey === 'work') {
        operations.push(
          { kind: 'assign', assigneeSubject: 'owner' },
          { kind: 'assign', assigneeSubject: 'operator' },
          { kind: 'add_note', note: 'Internal note just before expiry' },
        );
      }
      for (const operation of operations) {
        const result = await store.mutateRequest({
          scope,
          collectionKey: record.collectionKey,
          id: record.id,
          expectedRevision: record.revision,
          actorSubject: 'owner',
          operation,
        });
        if (!result.ok) throw new Error(`near-expiry ${operation.kind} failed`);
        record = result.record;
        expect(record).toMatchObject({
          createdAt: fixture.record.createdAt,
          retentionExpiresAt: fixture.record.retentionExpiresAt,
        });
      }
      fixture.record = record;
      expect(await store.getRequest(scope, record.collectionKey, record.id)).toEqual(record);
      const history = await store.listActivity(scope, record.collectionKey, record.id);
      expect(history.activities.some((event) => event.content !== undefined)).toBe(true);
      if (record.collectionKey === 'work') {
        expect(history.activities[0]?.content?.notes[0]?.text).toBe(
          'Internal note just before expiry',
        );
        expect(record.content?.payload.stage).toBe(fixture.input.payload.stage);
      } else expect(record.content?.payload).not.toHaveProperty('stage');
    }

    expect(await store.createInstallation(installationInput)).toMatchObject({
      disposition: 'replayed',
    });
    expect(
      await store.createInstallation({
        ...installationInput,
        retentionDays: retentionDays === 90 ? 7 : 90,
      }),
    ).toMatchObject({ disposition: 'conflict' });
    expect(
      await store.setIntakeState({
        scope,
        expectedRevision: 1,
        active: false,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true, installation: { intakeActive: false, retentionDays } });

    // Staff can still create while public intake is paused; each new record gets its own deadline.
    const fresh = await store.createRequest({
      scope,
      collectionKey: 'items',
      idempotencyKey: 'later-record',
      payload: { label: 'Later content' },
      origin: { kind: 'portal' },
      actorSubject: 'owner',
    });
    if (fresh.disposition !== 'created') throw new Error('later record was not created');
    expect(Date.parse(fresh.record.retentionExpiresAt) - Date.parse(fresh.record.createdAt)).toBe(
      retentionDays * DAY_MS,
    );
    for (const collectionKey of ['items', 'work']) {
      const records = await store.listRequests({ scope, collectionKey });
      expect(records.records).toHaveLength(collectionKey === 'items' ? 2 : 3);
      expect((await store.exportRequests({ scope, collectionKey })).records).toEqual(
        records.records,
      );
    }
    const pendingExport = await store.exportRequests({ scope, collectionKey: 'work', limit: 1 });
    if (pendingExport.nextCursor === undefined) throw new Error('expected an export continuation');

    // No purgeExpired call: every entry point must enforce expiry using its own authoritative clock.
    advance(1);
    expect(
      await store.exportRequests({
        scope,
        collectionKey: 'work',
        cursor: pendingExport.nextCursor,
      }),
    ).toMatchObject({ records: [], snapshotAt: pendingExport.snapshotAt });
    for (const includeDeleted of [false, true]) {
      for (const collectionKey of ['items', 'work']) {
        const expectedIds = collectionKey === 'items' ? [fresh.record.id] : [];
        expect(
          (await store.listRequests({ scope, collectionKey, includeDeleted })).records.map(
            (record) => record.id,
          ),
        ).toEqual(expectedIds);
        expect(
          (await store.exportRequests({ scope, collectionKey, includeDeleted })).records.map(
            (record) => record.id,
          ),
        ).toEqual(expectedIds);
      }
    }
    for (const [index, fixture] of fixtures.entries()) {
      const { input, record } = fixture;
      if (index === 0) {
        expect(await store.getRequest(scope, record.collectionKey, record.id)).toBeUndefined();
      } else if (index === 1) {
        expect(
          (await store.listActivity(scope, record.collectionKey, record.id)).activities.every(
            (event) => event.content === undefined,
          ),
        ).toBe(true);
      } else if (index === 2) {
        expect(await store.probeRequest(input)).toMatchObject({
          disposition: 'replayed',
          record: { deletionReason: 'retention_expired' },
        });
      } else {
        expect(
          await store.mutateRequest({
            scope,
            collectionKey: record.collectionKey,
            id: record.id,
            expectedRevision: record.revision,
            actorSubject: 'owner',
            operation: { kind: 'add_note', note: 'Must not revive content' },
          }),
        ).toMatchObject({ ok: false, reason: 'not_found' });
      }
      await expectExpired(store, record);
      const replay = await store.createRequest(input);
      expect(replay).toMatchObject({
        disposition: 'replayed',
        record: { id: record.id, deletionReason: 'retention_expired' },
      });
      if (replay.disposition !== 'replayed') throw new Error('expired replay was not retained');
      expect(replay.record).not.toHaveProperty('content');
      expect(replay.record.retentionExpiresAt).toBe(record.retentionExpiresAt);
    }
    advance(1);
    for (const { record } of fixtures) await expectExpired(store, record);
    expect(await store.getRequest(scope, 'items', fresh.record.id)).toEqual(fresh.record);
  });
}

async function expectExpired(store: BusinessInformationStore, record: ManagedRequestRecord) {
  const { scope, collectionKey, id } = record;
  expect(await store.getRequest(scope, collectionKey, id)).toBeUndefined();
  const tombstone = await store.getRequest(scope, collectionKey, id, { includeDeleted: true });
  expect(tombstone).toMatchObject({
    id,
    createdAt: record.createdAt,
    retentionExpiresAt: record.retentionExpiresAt,
    deletionReason: 'retention_expired',
  });
  expect(tombstone).not.toHaveProperty('content');
  const history = await store.listActivity(scope, collectionKey, id);
  expect(history.activities[0]?.kind).toBe('retention_expired');
  expect(history.activities.every((event) => event.content === undefined)).toBe(true);
  const exported = await store.exportRequests({ scope, collectionKey, includeDeleted: true });
  expect(exported.records.find((candidate) => candidate.id === id)).toEqual(tombstone);
}

function retentionDefinition(): SolutionDefinitionSnapshot {
  const collections: InstalledCollectionDefinition[] = ['items', 'work'].map((key) => {
    const recordSchema: JsonObject = {
      type: 'object',
      additionalProperties: false,
      required: key === 'work' ? ['label', 'stage'] : ['label'],
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 200 },
        ...(key === 'work'
          ? { stage: { type: 'string', enum: ['open', 'resolved', 'awaiting_supplier'] } }
          : {}),
      },
    };
    return {
      key,
      title: key,
      singularTitle: 'Item',
      description: 'Synthetic retention records',
      authority: { authority: 'native' },
      schemaVersion: 1,
      schemaDigest: createHash('sha256').update(JSON.stringify(recordSchema)).digest('hex'),
      recordSchema,
      summaryFields: ['label'],
      publicFields: key === 'work' ? ['label', 'stage'] : ['label'],
      ...(key === 'work' ? { management: { assignment: true, notes: true } } : {}),
    };
  });
  return {
    reference: {
      kind: 'private',
      publisherOrg: 'retention',
      app: 'records',
      env: 'prod',
      deploymentId: 'retention-v1',
      version: '1.0.0',
      digest: createHash('sha256').update(JSON.stringify(collections)).digest('hex'),
    },
    title: 'Retention proof',
    description: 'Records with independent lifecycle semantics',
    collections,
  };
}

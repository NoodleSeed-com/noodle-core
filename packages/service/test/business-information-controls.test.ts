import { describe, expect, it } from 'vitest';
import type {
  InstalledCollectionDefinition,
  SolutionDefinitionSnapshot,
} from '../src/business-information/contracts.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { PayloadValidationError } from '../src/business-information/validation.js';

const scope = { org: 'acme', app: 'tasks', env: 'test', installationId: 'tasks-test' };
function collection(
  management?: InstalledCollectionDefinition['management'],
): InstalledCollectionDefinition {
  return {
    key: 'items',
    title: 'Items',
    singularTitle: 'Item',
    description: 'Custom lightweight records.',
    schemaVersion: 1,
    schemaDigest: 'a'.repeat(64),
    authority: { authority: 'native' },
    summaryFields: ['summary'],
    recordSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'stage'],
      properties: {
        summary: { type: 'string', maxLength: 100 },
        stage: { type: 'string', enum: ['triage', 'waiting', 'completed'], default: 'triage' },
        reference: { type: 'string', maxLength: 100, default: 'internal' },
      },
    },
    publicFields: ['summary'],
    editableFields: ['summary', 'stage'],
    ...(management === undefined ? {} : { management }),
  };
}
async function setup(management?: InstalledCollectionDefinition['management']) {
  let id = 0;
  const store = new InMemoryBusinessInformationStore({ id: () => `item_${++id}` });
  const definition: SolutionDefinitionSnapshot = {
    reference: {
      kind: 'private',
      publisherOrg: 'acme',
      app: 'tasks',
      env: 'test',
      deploymentId: 'dep_tasks',
      version: '1',
      digest: 'b'.repeat(64),
    },
    title: 'Tasks',
    description: 'Custom tasks.',
    collections: [collection(management)],
  };
  await store.createInstallation({
    scope,
    definition,
    managedCollections: ['items'],
    actorSubject: 'owner',
    actorEmail: 'owner@example.com',
  });
  const create = (payload: unknown) =>
    store.createRequest({
      scope,
      collectionKey: 'items',
      payload,
      publicInput: true,
      idempotencyKey: `create-${++id}`,
      origin: { kind: 'mcp' },
      actorSubject: 'visitor',
    });
  return { store, create };
}
describe('lightweight native record controls', () => {
  it('requires active application authority for staff creates while retaining old receipts and edits', async () => {
    const { store } = await setup();
    let active = false;
    const generation = new Date().toISOString();
    store.configureApplicationLifecycle(async () => ({ generation, active }));
    const create = (key: string) =>
      store.createRequest({
        scope,
        collectionKey: 'items',
        payload: { summary: 'Staff record' },
        origin: { kind: 'portal' },
        actorSubject: 'owner',
        idempotencyKey: key,
      });
    expect(await create('first')).toEqual({ disposition: 'paused' });
    active = true;
    expect(await create('first')).toEqual({ disposition: 'paused' });
    expect(await store.bindApplication(scope, generation)).toBe(true);
    expect(
      await store.setIntakeState({
        scope,
        active: false,
        expectedRevision: 1,
        actorSubject: 'owner',
      }),
    ).toMatchObject({ ok: true });
    const accepted = await create('first');
    if (accepted.disposition !== 'created') throw new Error('staff create missing');
    active = false;
    expect(await create('second')).toEqual({ disposition: 'paused' });
    expect((await create('first')).disposition).toBe('replayed');
    expect(
      await store.mutateRequest({
        scope,
        collectionKey: 'items',
        id: accepted.record.id,
        expectedRevision: 1,
        actorSubject: 'owner',
        operation: { kind: 'update', payload: { summary: 'Retained edit' } },
      }),
    ).toMatchObject({ ok: true });
  });
  it('accepts bounded multiline notes and rejects content/count limits without changing the record', async () => {
    const { store, create } = await setup({ notes: true });
    const created = await create({ summary: 'Note boundary' });
    if (created.disposition !== 'created') throw new Error('expected record');
    const command = { scope, collectionKey: 'items', id: created.record.id, actorSubject: 'owner' };
    for (const note of ['x'.repeat(4_001), 'Bearer secret-token']) {
      await expect(
        store.mutateRequest({
          ...command,
          expectedRevision: 1,
          operation: { kind: 'add_note', note },
        }),
      ).rejects.toBeInstanceOf(PayloadValidationError);
    }
    for (let index = 0; index < 50; index++) {
      expect(
        await store.mutateRequest({
          ...command,
          expectedRevision: index + 1,
          operation: {
            kind: 'add_note',
            note: index === 0 ? 'First line\nSecond line' : 'x'.repeat(4_000),
          },
        }),
      ).toMatchObject({ ok: true });
    }
    await expect(
      store.mutateRequest({
        ...command,
        expectedRevision: 51,
        operation: { kind: 'add_note', note: 'One too many' },
      }),
    ).rejects.toMatchObject({ code: 'array_too_large' });
    const record = await store.getRequest(scope, 'items', created.record.id);
    expect(record?.revision).toBe(51);
    expect(record?.content?.notes).toHaveLength(50);
    expect(record?.content?.notes[0]?.text).toBe('First line\nSecond line');
  });
  it('applies defaults once, rejects public overposting and merges admitted staff edits', async () => {
    const { store, create } = await setup();
    const created = await create({ summary: 'Need help' });
    expect(created.disposition).toBe('created');
    if (created.disposition !== 'created') throw new Error('expected record');
    expect(created.record).not.toHaveProperty('status');
    expect(created.record.content?.payload).toEqual({
      summary: 'Need help',
      stage: 'triage',
      reference: 'internal',
    });
    await expect(create({ summary: 'Need help', stage: 'completed' })).rejects.toThrow(/public/);
    const update = await store.mutateRequest({
      scope,
      collectionKey: 'items',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'owner',
      operation: { kind: 'update', payload: { stage: 'waiting' } },
    });
    expect(update).toMatchObject({
      ok: true,
      record: {
        content: { payload: { summary: 'Need help', stage: 'waiting', reference: 'internal' } },
      },
    });
    await expect(
      store.mutateRequest({
        scope,
        collectionKey: 'items',
        id: created.record.id,
        expectedRevision: 2,
        actorSubject: 'owner',
        operation: { kind: 'update', payload: { reference: 'changed' } },
      }),
    ).rejects.toThrow(/editable/);
  });
  it.each([
    undefined,
    { assignment: true },
    { notes: true },
    { assignment: true, notes: true },
  ] as const)('enforces each independent control combination %j', async (management) => {
    const { store, create } = await setup(management);
    const created = await create({ summary: 'Need help' });
    if (created.disposition !== 'created') throw new Error('expected record');
    const mutation = {
      scope,
      collectionKey: 'items',
      id: created.record.id,
      actorSubject: 'owner',
    };
    const assigned = await store.mutateRequest({
      ...mutation,
      expectedRevision: 1,
      operation: { kind: 'assign', assigneeSubject: 'owner' },
    });
    expect(assigned.ok).toBe(management?.assignment === true);
    const noted = await store.mutateRequest({
      ...mutation,
      expectedRevision: assigned.ok ? 2 : 1,
      operation: { kind: 'add_note', note: 'Handled privately' },
    });
    expect(noted.ok).toBe(management?.notes === true);
  });
});

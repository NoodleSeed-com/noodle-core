import { createHash } from 'node:crypto';
import { InMemoryDailyCounterStore } from '@noodle-borg/admission-limits/portable';
import { ARTIFACT_SCHEMA_VERSION, type RuntimeArtifact } from '@noodle-borg/compiler';
import type { ConnectorCall } from '@noodle-borg/runtime';
import { describe, expect, it, vi } from 'vitest';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { createDeploymentNativeRecordConnector } from '../src/native-record-connector.js';

async function setup(installed = true) {
  const tenant = { org: 'acme', app: 'items', env: 'prod' };
  const store = new InMemoryBusinessInformationStore();
  const counters = new InMemoryDailyCounterStore();
  const artifact: RuntimeArtifact = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: 'resolved',
    source: { manifestName: 'items', manifestVersion: '1.0.0', coreVersion: '2' },
    server: {
      name: 'items',
      version: '1.0.0',
      title: 'Items',
      managedCollections: [
        {
          name: 'items',
          title: 'Items',
          description: 'Requested items',
          schemaVersion: 1,
          schemaDigest: 'a'.repeat(64),
          source: { authority: 'native' },
          publicFields: ['label'],
          editableFields: ['label', 'stage', 'reference'],
          recordSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['label', 'stage'],
            properties: {
              label: { type: 'string', maxLength: 100 },
              stage: { type: 'string', enum: ['new', 'done'], default: 'new' },
              reference: { type: 'string', maxLength: 100 },
            },
          },
        },
      ],
    },
    tools: [],
    capabilities: { tools: [] },
  };
  const scope = { ...tenant, installationId: 'items-prod' };
  if (installed)
    await store.createInstallation({
      scope,
      definition: privateDefinitionFromDeployment(
        {
          publisherOrg: tenant.org,
          app: tenant.app,
          environment: tenant.env,
          deploymentId: 'dep_1',
        },
        { ...tenant, environment: tenant.env, deploymentId: 'dep_1', artifact },
      ),
      managedCollections: ['items'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
  const dependencies = { store, counters, publicIntakeEnabled: true };
  const connector = createDeploymentNativeRecordConnector(
    { tenant, artifact, deploymentId: 'dep_1' },
    dependencies,
  );
  if (connector === undefined) throw new Error('connector unavailable');
  const call = (
    operation: string,
    args: Record<string, unknown>,
    extra: Partial<ConnectorCall> = {},
  ) =>
    connector.invoke({
      operation,
      args,
      credential: { token: '' },
      publicAdmission: { network: 'trusted-network', visitor: 'trusted-visitor' },
      execution: {
        id: createHash('sha256').update(JSON.stringify({ operation, args })).digest('hex'),
      },
      ...extra,
    });
  return { store, counters, scope, call, dependencies };
}

describe('deployment-bound native record connector', () => {
  it('honors the fleet public stop without blocking receipt recovery or authorized staff work', async () => {
    const { call, dependencies, counters } = await setup();
    const count = vi.spyOn(counters, 'consumeAllOnce');
    const args = { collection: 'items', payload: { label: 'Accepted' } };
    const accepted = await call('submit_record', args);
    dependencies.publicIntakeEnabled = false;
    expect(await call('submit_record', args)).toEqual(accepted);
    await expect(
      call('submit_record', { collection: 'items', payload: { label: 'Blocked' } }),
    ).rejects.toMatchObject({ status: 503 });
    expect(count).toHaveBeenCalledTimes(1);
    expect(
      await call(
        'create_record',
        { collection: 'items', payload: { label: 'Staff' } },
        { caller: { subject: 'owner', identityKind: 'platform' } },
      ),
    ).toMatchObject({ ok: true });
  });
  it('submits validated public fields with a receipt, shared admission and trusted execution replay', async () => {
    const { call, store, scope, counters } = await setup();
    const count = vi.spyOn(counters, 'consumeAllOnce');
    const args = { collection: 'items', payload: { label: 'Requested item' } };
    const receipt = await call('submit_record', args);
    expect(receipt).toMatchObject({ ok: true, recordId: expect.any(String), revision: 1 });
    expect(receipt).not.toHaveProperty('record');
    expect(await call('submit_record', args)).toEqual(receipt);
    expect(count).toHaveBeenCalledTimes(1);
    expect((await store.listRequests({ scope, collectionKey: 'items' })).records).toMatchObject([
      { content: { payload: { label: 'Requested item', stage: 'new' } } },
    ]);
    await expect(
      call('submit_record', { collection: 'items', payload: { label: 'Attack', stage: 'done' } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(count).toHaveBeenCalledTimes(1);
    await expect(
      call(
        'submit_record',
        { collection: 'items', payload: { label: 'No network' } },
        { publicAdmission: undefined },
      ),
    ).rejects.toMatchObject({ status: 503 });
    await expect(call('submit_record', args, { execution: undefined })).rejects.toMatchObject({
      status: 503,
    });
  });
  it('requires live platform business grants, isolates collections and enforces revision checks', async () => {
    const { call, store, scope } = await setup();
    const caller = { subject: 'owner', identityKind: 'platform' as const };
    await expect(call('list_records', { collection: 'items' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      call(
        'list_records',
        { collection: 'items' },
        { caller: { ...caller, identityKind: 'customer' } },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      call('list_records', { collection: 'items', cursor: 'forged' }, { caller }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      call(
        'create_record',
        { collection: 'items', payload: { label: 'Cancelled' } },
        { caller, signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ status: 503 });
    const created = (await call(
      'create_record',
      { collection: 'items', payload: { label: 'Staff item', stage: 'done', reference: 'CLEAR' } },
      { caller },
    )) as { record: { id: string } };
    await expect(
      call(
        'update_record',
        {
          collection: 'items',
          id: created.record.id,
          expectedRevision: 2,
          patch: { label: 'Stale' },
        },
        { caller },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      call('get_record', { collection: 'other', id: created.record.id }, { caller }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await call('get_record', { collection: 'items', id: created.record.id }, { caller }),
    ).toMatchObject({
      record: { id: created.record.id, payload: { label: 'Staff item', stage: 'done' } },
    });
    expect(await call('list_records', { collection: 'items', limit: 1 }, { caller })).toMatchObject(
      { records: [{ id: created.record.id }] },
    );
    expect(
      await call(
        'update_record',
        {
          collection: 'items',
          id: created.record.id,
          expectedRevision: 1,
          patch: { label: 'Updated' },
          unset: ['reference'],
        },
        { caller },
      ),
    ).toMatchObject({ record: { revision: 2, payload: { label: 'Updated' } } });
    expect(
      await call('get_record', { collection: 'items', id: created.record.id }, { caller }),
    ).not.toHaveProperty('record.payload.reference');
    expect(
      await call(
        'delete_record',
        { collection: 'items', id: created.record.id, expectedRevision: 2 },
        { caller },
      ),
    ).toMatchObject({ ok: true, recordId: created.record.id, revision: 3 });
    await expect(
      call('get_record', { collection: 'items', id: created.record.id }, { caller }),
    ).rejects.toMatchObject({ status: 404 });
    await store.setGrant({
      scope,
      subject: 'second',
      email: 'second@example.com',
      role: 'administrator',
      actorSubject: 'owner',
      expectedRevision: 0,
    });
    await store.revokeGrant({
      scope,
      subject: 'owner',
      actorSubject: 'second',
      expectedRevision: 1,
    });
    await expect(
      call('get_record', { collection: 'items', id: created.record.id }, { caller }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('rechecks public pause atomically after admission and before the storage write', async () => {
    const { call, store, counters, scope } = await setup();
    const consume = counters.consumeAllOnce.bind(counters);
    vi.spyOn(counters, 'consumeAllOnce').mockImplementation(async (...args) => {
      const result = await consume(...args);
      await store.setIntakeState({
        scope,
        active: false,
        expectedRevision: 1,
        actorSubject: 'owner',
      });
      return result;
    });
    await expect(
      call('submit_record', { collection: 'items', payload: { label: 'Paused while admitting' } }),
    ).rejects.toMatchObject({ status: 503 });
    expect((await store.listRequests({ scope, collectionKey: 'items' })).records).toEqual([]);
  });
  it('fails closed before installation instead of creating an implicit store', async () => {
    const { call } = await setup(false);
    await expect(
      call('submit_record', { collection: 'items', payload: { label: 'Unavailable' } }),
    ).rejects.toMatchObject({ status: 503 });
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  InstalledCollectionDefinition,
  SolutionDefinitionSnapshot,
} from '../src/business-information/contracts.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';
import { effectiveInstallation } from '../src/business-information/model.js';
import {
  builtInDefinition,
  builtInDefinitionAtRelease,
} from '../src/business-information/profiles.js';

const assetSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['code', 'label', 'quantity'],
  properties: {
    code: { type: 'string', minLength: 1 },
    label: { type: 'string', minLength: 1 },
    quantity: { type: 'integer', minimum: 0 },
  },
} as const;

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function collection(
  key: string,
  authority: InstalledCollectionDefinition['authority'],
): InstalledCollectionDefinition {
  return {
    key,
    title: key === 'assets' ? 'Assets' : 'Stock',
    singularTitle: key === 'assets' ? 'Asset' : 'Stock item',
    description: 'Synthetic equipment application records.',
    schemaVersion: 1,
    schemaDigest: digest(assetSchema),
    recordSchema: assetSchema,
    summaryFields: ['code', 'label', 'quantity'],
    authority,
  };
}

const definition: SolutionDefinitionSnapshot = {
  reference: {
    kind: 'private',
    publisherOrg: 'acme',
    app: 'equipment',
    env: 'prod',
    deploymentId: 'dep_equipment_v1',
    version: '1.0.0',
    digest: 'a'.repeat(64),
  },
  title: 'Equipment operations',
  description: 'Operate native assets and inspect source-owned stock.',
  collections: [
    collection('assets', { authority: 'native' }),
    collection('stock', {
      authority: 'external',
      connectorAlias: 'inventory',
      connectorId: 'inventory_api',
      connectorVersion: '1.0.0',
      scanOperation: 'scan_stock',
      scanSignatureHash: `sha256v2:${'b'.repeat(64)}`,
    }),
  ],
};

describe('generic business information', () => {
  it('installs a tools-and-settings application without inventing a collection', async () => {
    const store = new InMemoryBusinessInformationStore();
    const installed = await store.createInstallation({
      scope: { org: 'acme', app: 'equipment', env: 'prod', installationId: 'equipment-prod' },
      definition: { ...definition, collections: [] },
      managedCollections: [],
      actorSubject: 'owner',
    });
    expect(installed.disposition).toBe('created');
    expect(installed.installation.definition.collections).toEqual([]);
    expect(installed.installation.managedCollections).toEqual([]);
    expect(await store.listInstallationsForSubject('owner')).toHaveLength(1);
  });

  it('applies one compatible managed release to earlier installations while private definitions stay pinned', () => {
    const current = builtInDefinition('travel');
    const installed = builtInDefinitionAtRelease('travel', 1);
    if (current.reference.kind !== 'managed') throw new Error('expected managed definition');
    const earlier = {
      scope: { org: 'acme', app: 'travel', env: 'prod', installationId: 'travel-prod' },
      publicId: 'sol_travel',
      profileKey: 'travel',
      profileVersion: 1,
      managedCollections: ['travel_requests'],
      definition: installed,
      retentionDays: 30 as const,
      revision: 1,
      createdAt: '2026-09-01T00:00:00.000Z',
      createdBySubject: 'owner',
      updatedAt: '2026-09-01T00:00:00.000Z',
      updatedBySubject: 'owner',
    };

    expect(effectiveInstallation(earlier)).toMatchObject({
      publicId: 'sol_travel',
      profileVersion: current.reference.release,
      revision: 1,
      managedCollections: ['travel_requests'],
      definition: { reference: current.reference },
    });

    const privateInstallation = { ...earlier, definition, profileKey: 'equipment' };
    expect(effectiveInstallation(privateInstallation).definition).toEqual(definition);
  });

  it('operates a custom native collection without request workflow fields', async () => {
    const store = new InMemoryBusinessInformationStore({
      id: () => 'asset_1',
      publicId: () => 'sol_equipment',
    });
    const scope = { org: 'acme', app: 'equipment', env: 'prod', installationId: 'equipment-prod' };
    const installed = await store.createInstallation({
      scope,
      definition,
      managedCollections: ['assets', 'stock'],
      actorSubject: 'owner',
      actorEmail: 'owner@example.com',
    });
    expect(installed.disposition).toBe('created');

    const created = await store.createRequest({
      scope,
      collectionKey: 'assets',
      idempotencyKey: 'asset-create-1',
      payload: { code: 'EQ-1', label: 'Projector', quantity: 2 },
      origin: { kind: 'portal' },
      actorSubject: 'owner',
    });
    expect(created.record).not.toHaveProperty('status');
    const updated = await store.mutateRequest({
      scope,
      collectionKey: 'assets',
      id: created.record.id,
      expectedRevision: 1,
      actorSubject: 'owner',
      operation: {
        kind: 'update',
        payload: { code: 'EQ-1', label: 'Projector', quantity: 3 },
      },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.record.content?.payload).toMatchObject({ quantity: 3 });

    const assignment = await store.mutateRequest({
      scope,
      collectionKey: 'assets',
      id: created.record.id,
      expectedRevision: 2,
      actorSubject: 'owner',
      operation: { kind: 'assign', assigneeSubject: 'operator' },
    });
    expect(assignment).toMatchObject({ ok: false, reason: 'invalid_transition' });
  });

  it('rejects local creation in an externally authoritative collection', async () => {
    const store = new InMemoryBusinessInformationStore();
    const scope = { org: 'acme', app: 'equipment', env: 'prod', installationId: 'equipment-prod' };
    await store.createInstallation({
      scope,
      definition,
      managedCollections: ['assets', 'stock'],
      actorSubject: 'owner',
    });
    await expect(
      store.createRequest({
        scope,
        collectionKey: 'stock',
        idempotencyKey: 'stock-create-1',
        payload: { code: 'EQ-1', label: 'Projector', quantity: 3 },
        origin: { kind: 'portal' },
        actorSubject: 'owner',
      }),
    ).rejects.toThrow(/externally authoritative/);
  });
});

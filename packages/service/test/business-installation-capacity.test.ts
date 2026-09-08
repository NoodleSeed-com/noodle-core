import { describe, expect, it } from 'vitest';
import type { SolutionDefinitionSnapshot } from '../src/business-information/contracts.js';
import { InMemoryBusinessInformationStore } from '../src/business-information/in-memory-store.js';

// Capacity semantics are profile-independent, so avoid managed profile resolution in this fixture.
const definition: SolutionDefinitionSnapshot = {
  reference: {
    kind: 'private',
    publisherOrg: 'acme',
    app: 'capacity',
    env: 'prod',
    deploymentId: 'dep_capacity_v1',
    version: '1.0.0',
    digest: 'a'.repeat(64),
  },
  title: 'Capacity fixture',
  description: 'Minimal generic definition for retained installation capacity tests.',
  collections: [],
};

const input = (org: string, index: number) => ({
  scope: { org, app: `app-${index}`, env: 'prod', installationId: `install-${index}` },
  definition,
  managedCollections: [],
  actorSubject: 'owner',
});
describe('retained installation capacity', () => {
  it('bounds all retained drafts while preserving exact replay, conflict and other organizations', async () => {
    const store = new InMemoryBusinessInformationStore();
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) => store.createInstallation(input('acme', index))),
    );
    await expect(store.createInstallation(input('acme', 1000))).rejects.toMatchObject({
      code: 'installation_capacity_exceeded',
    });
    expect((await store.createInstallation(input('acme', 0))).disposition).toBe('replayed');
    expect(
      (await store.createInstallation({ ...input('acme', 0), retentionDays: 7 })).disposition,
    ).toBe('conflict');
    expect((await store.createInstallation(input('other', 1000))).disposition).toBe('created');
    expect(await store.listInstallations('acme')).toHaveLength(1000);
    expect(await store.getGrant(input('acme', 0).scope, 'owner')).toMatchObject({
      role: 'administrator',
      revision: 1,
    });
  });
});

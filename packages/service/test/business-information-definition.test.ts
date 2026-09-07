import { ARTIFACT_SCHEMA_VERSION, type RuntimeArtifact } from '@noodle-borg/compiler';
import { describe, expect, it } from 'vitest';
import { privateDefinitionFromDeployment } from '../src/business-information/definition-resolver.js';

function artifact(): RuntimeArtifact {
  return {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: 'resolved',
    source: { manifestName: 'equipment', manifestVersion: '1.0.0', coreVersion: '2' },
    server: {
      name: 'equipment',
      version: '1.0.0',
      title: 'Equipment operations',
      managedCollections: [
        {
          name: 'assets',
          title: 'Assets',
          description: 'Equipment owned by the business.',
          schemaVersion: 1,
          schemaDigest: 'a'.repeat(64),
          recordSchema: {
            type: 'object',
            additionalProperties: false,
            required: ['code'],
            properties: { code: { type: 'string' } },
          },
          source: { authority: 'native' },
        },
      ],
    },
    tools: [],
    capabilities: { tools: [] },
  };
}

describe('private solution definition resolution', () => {
  it('freezes the exact resolved deployment and its generic collections', () => {
    const definition = privateDefinitionFromDeployment(
      {
        publisherOrg: 'acme',
        app: 'equipment',
        environment: 'prod',
        deploymentId: 'dep_1',
      },
      {
        deploymentId: 'dep_1',
        org: 'acme',
        app: 'equipment',
        environment: 'prod',
        artifact: artifact(),
      },
    );
    expect(definition.reference).toMatchObject({
      kind: 'private',
      deploymentId: 'dep_1',
      version: '1.0.0',
    });
    expect(definition.collections[0]).toMatchObject({
      key: 'assets',
      authority: { authority: 'native' },
    });
  });

  it('accepts a resolved application without business collections', () => {
    const compiled = artifact();
    const definition = privateDefinitionFromDeployment(
      { publisherOrg: 'acme', app: 'equipment', environment: 'prod', deploymentId: 'dep_1' },
      {
        deploymentId: 'dep_1',
        org: 'acme',
        app: 'equipment',
        environment: 'prod',
        artifact: { ...compiled, server: { ...compiled.server, managedCollections: [] } },
      },
    );
    expect(definition.collections).toEqual([]);
    expect(definition.reference).toMatchObject({ kind: 'private', deploymentId: 'dep_1' });
  });

  it('fails closed for a stale deployment reference', () => {
    expect(() =>
      privateDefinitionFromDeployment(
        {
          publisherOrg: 'acme',
          app: 'equipment',
          environment: 'prod',
          deploymentId: 'dep_old',
        },
        {
          deploymentId: 'dep_new',
          org: 'acme',
          app: 'equipment',
          environment: 'prod',
          artifact: artifact(),
        },
      ),
    ).toThrow(/immutable reference/);
  });
});

import { sha256Canonical } from '@noodle-borg/app-package';
import { projectManagedCollectionControls, type RuntimeArtifact } from '@noodle-borg/compiler';
import type {
  InstalledCollectionDefinition,
  JsonObject,
  SolutionDefinitionSnapshot,
} from './contracts.js';

export interface PrivateDefinitionSelector {
  readonly publisherOrg: string;
  readonly app: string;
  readonly environment: string;
  readonly deploymentId: string;
}

export interface PrivateDefinitionDeployment {
  readonly deploymentId: string;
  readonly org: string;
  readonly app: string;
  readonly environment: string;
  readonly artifact: RuntimeArtifact;
}

/**
 * Validate and freeze an active deployment as an immutable private solution definition.
 * Authorization and active-deployment lookup happen before this pure boundary.
 */
export function privateDefinitionFromDeployment(
  selector: PrivateDefinitionSelector,
  deployment: PrivateDefinitionDeployment,
): SolutionDefinitionSnapshot {
  if (
    deployment.deploymentId !== selector.deploymentId ||
    deployment.org !== selector.publisherOrg ||
    deployment.app !== selector.app ||
    deployment.environment !== selector.environment
  ) {
    throw new Error(
      'private definition deployment does not match the requested immutable reference',
    );
  }
  if (deployment.artifact.resolution !== 'resolved') {
    throw new Error('private definition requires a fully resolved runtime artifact');
  }
  const authored = deployment.artifact.server.managedCollections ?? [];
  const collections = authored.map(collectionFromArtifact);
  const digest = sha256Canonical({
    deploymentId: deployment.deploymentId,
    server: {
      name: deployment.artifact.server.name,
      version: deployment.artifact.server.version,
      title: deployment.artifact.server.title,
      managedCollections: authored,
      ...(deployment.artifact.server.variables === undefined
        ? {}
        : { variables: deployment.artifact.server.variables }),
    },
  });
  return {
    reference: {
      kind: 'private',
      publisherOrg: deployment.org,
      app: deployment.app,
      env: deployment.environment,
      deploymentId: deployment.deploymentId,
      version: deployment.artifact.server.version,
      digest,
    },
    title: deployment.artifact.server.title,
    description:
      deployment.artifact.server.instructions ??
      `Business operations for ${deployment.artifact.server.title}.`,
    collections,
    ...(deployment.artifact.server.variables === undefined
      ? {}
      : { variables: structuredClone(deployment.artifact.server.variables) }),
  };
}

function collectionFromArtifact(
  collection: NonNullable<RuntimeArtifact['server']['managedCollections']>[number],
): InstalledCollectionDefinition {
  const source = collection.source;
  const authority: InstalledCollectionDefinition['authority'] =
    source.authority === 'native' ? { authority: 'native' } : externalAuthority(source);
  return {
    key: collection.name,
    title: collection.title,
    singularTitle: singularize(collection.title),
    description: collection.description,
    schemaVersion: collection.schemaVersion,
    schemaDigest: collection.schemaDigest.replace(/^sha256:/, ''),
    recordSchema: structuredClone(collection.recordSchema) as JsonObject,
    ...projectManagedCollectionControls(collection),
    summaryFields: collection.summaryFields ?? summaryFields(collection.recordSchema),
    authority,
    ...(collection.behavior === undefined ? {} : { behavior: collection.behavior }),
  };
}

function externalAuthority(
  source: Extract<
    NonNullable<RuntimeArtifact['server']['managedCollections']>[number]['source'],
    { authority: 'external' }
  >,
): Extract<InstalledCollectionDefinition['authority'], { authority: 'external' }> {
  if (!source.scan.resolved) {
    throw new Error('external collection source operations must be fully resolved');
  }
  return {
    authority: 'external',
    connectorAlias: source.connectorAlias,
    connectorId: source.connectorId,
    connectorVersion: source.connectorVersion,
    scanOperation: source.scan.operation,
    scanSignatureHash: source.scan.signatureHash,
  };
}

function summaryFields(schema: Readonly<Record<string, unknown>>): readonly string[] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((field): field is string => typeof field === 'string')
    : [];
  const properties =
    schema.properties !== null &&
    typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties)
      ? Object.keys(schema.properties)
      : [];
  return [...new Set([...required, ...properties])].slice(0, 6);
}

function singularize(title: string): string {
  return title.endsWith('s') && title.length > 1 ? title.slice(0, -1) : title;
}

import type { CapabilityRequirementName } from '@noodle-borg/capabilities';
import type { PackagedAsset } from '../assets.js';
import type { ConnectorCatalog } from '../catalog/types.js';
import type { DeclaredConnectorRef } from '../fulfilment-emit.js';
import type { Manifest } from '../manifest/schema.js';
import { artifactConfig } from './config.js';
import {
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactPackagedAsset,
  type ArtifactPrompt,
  type ArtifactResource,
  type ArtifactTool,
  type RuntimeArtifact,
} from './types.js';

interface ArtifactAssemblyOptions {
  readonly catalog?: ConnectorCatalog;
}

interface ArtifactAssemblyInput {
  readonly manifest: Manifest;
  readonly options: ArtifactAssemblyOptions;
  readonly runtimeBranding: RuntimeArtifact['server']['branding'];
  readonly runtimeShell: RuntimeArtifact['server']['shell'];
  readonly artifactAmbientContext:
    | NonNullable<NonNullable<RuntimeArtifact['server']['context']>['ambient']>
    | undefined;
  readonly state: RuntimeArtifact['server']['state'];
  readonly artifactTools: readonly ArtifactTool[];
  readonly allResources: readonly ArtifactResource[];
  readonly artifactPrompts: readonly ArtifactPrompt[];
  readonly packagedAssets: readonly PackagedAsset[];
  readonly requirements: readonly CapabilityRequirementName[];
  readonly declared: Record<string, DeclaredConnectorRef>;
  readonly customerEndpoints: RuntimeArtifact['customerEndpoints'];
  readonly knowledge?: RuntimeArtifact['server']['knowledge'];
  readonly managedCollections?: RuntimeArtifact['server']['managedCollections'];
}

export function assembleRuntimeArtifact({
  manifest,
  options,
  runtimeBranding,
  runtimeShell,
  artifactAmbientContext,
  state,
  artifactTools,
  allResources,
  artifactPrompts,
  packagedAssets,
  requirements,
  declared,
  customerEndpoints,
  knowledge,
  managedCollections,
}: ArtifactAssemblyInput): RuntimeArtifact {
  // 4. Assemble the artifact. `resources`/`prompts` and their capability lists are emitted only when
  // present, keeping a tools-only artifact byte-identical to before this slice.
  const capabilities: RuntimeArtifact['capabilities'] = {
    tools: artifactTools.map((tool) => tool.name),
    ...(allResources.length > 0 ? { resources: allResources.map((r) => r.name) } : {}),
    ...(artifactPrompts.length > 0 ? { prompts: artifactPrompts.map((p) => p.name) } : {}),
  };
  const connectorBindings = Object.fromEntries(
    Object.entries(declared).flatMap(([alias, connector]) =>
      connector.binding === undefined ? [] : [[alias, connector.binding]],
    ),
  );
  const config = artifactConfig(
    manifest,
    artifactTools,
    allResources,
    artifactPrompts,
    connectorBindings,
    artifactAmbientContext?.fulfilment,
  );
  const artifact: RuntimeArtifact = {
    artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
    resolution: options.catalog ? 'resolved' : 'shape-only',
    source: {
      manifestName: manifest.server.name,
      manifestVersion: manifest.server.version,
      ...(manifest.manifestVersion === '2' ? { coreVersion: '2' as const } : {}),
    },
    server: {
      name: manifest.server.name,
      version: manifest.server.version,
      title: manifest.server.title,
      ...(manifest.server.instructions !== undefined
        ? { instructions: manifest.server.instructions }
        : {}),
      ...(manifest.server.context !== undefined
        ? {
            context: {
              ...(manifest.server.context.defaults !== undefined
                ? { defaults: manifest.server.context.defaults }
                : {}),
              ...(artifactAmbientContext !== undefined ? { ambient: artifactAmbientContext } : {}),
            },
          }
        : {}),
      ...(manifest.server.interactions !== undefined
        ? { interactions: manifest.server.interactions }
        : {}),
      ...(manifest.server.auth !== undefined ? { auth: manifest.server.auth } : {}),
      ...(knowledge !== undefined && knowledge.length > 0 ? { knowledge } : {}),
      ...(managedCollections !== undefined && managedCollections.length > 0
        ? { managedCollections }
        : {}),
      ...(manifest.server.assistant !== undefined ? { assistant: manifest.server.assistant } : {}),
      ...(runtimeBranding !== undefined ? { branding: runtimeBranding } : {}),
      ...(runtimeShell !== undefined ? { shell: runtimeShell } : {}),
      ...(manifest.handoff !== undefined ? { handoff: manifest.handoff } : {}),
      ...(state !== undefined ? { state } : {}),
    },
    tools: artifactTools,
    ...(allResources.length > 0 ? { resources: allResources } : {}),
    ...(artifactPrompts.length > 0 ? { prompts: artifactPrompts } : {}),
    ...(packagedAssets.length > 0 ? { assets: packagedAssets.map(toArtifactAsset) } : {}),
    capabilities,
    ...(requirements.length > 0 ? { requirements: { capabilities: requirements } } : {}),
    ...(Object.keys(connectorBindings).length > 0 ? { connectorBindings } : {}),
    ...(customerEndpoints === undefined ? {} : { customerEndpoints }),
    ...(config !== undefined ? { config } : {}),
  };

  return artifact;
}

function toArtifactAsset(asset: PackagedAsset): ArtifactPackagedAsset {
  return {
    logicalId: asset.logicalId,
    sourcePath: asset.sourcePath,
    contentHash: asset.contentHash,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    width: asset.width,
    height: asset.height,
    publicUrl: asset.publicUrl,
    ...(asset.objectKey !== undefined ? { objectKey: asset.objectKey } : {}),
  };
}

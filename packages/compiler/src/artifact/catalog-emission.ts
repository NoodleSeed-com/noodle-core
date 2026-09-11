import type { ConnectorCatalog } from '../catalog/types.js';
import { emitAmbientContext, type StructuralAmbientContext } from '../context-compile.js';
import { CustomerRoutingCollector } from '../customer-routing.js';
import type { CompileError } from '../errors.js';
import { type DeclaredConnectorRef, emitFulfilment, withDialect } from '../fulfilment-emit.js';
import type { StructFulfilment } from '../fulfilment-structural.js';
import type { Manifest } from '../manifest/schema.js';
import { requiresToolConfirmation } from './consent.js';
import type {
  ArtifactMeta,
  ArtifactPrompt,
  ArtifactResource,
  ArtifactTool,
  JsonSchema,
  RuntimeArtifact,
  WidgetUiMeta,
} from './types.js';

/** A tool whose structural checks passed, paired with its parsed fulfilment + resolved schemas. */
export interface StructuralTool {
  readonly tool: Manifest['tools'][number];
  readonly index: number;
  readonly inputSchema: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly fulfilment: StructFulfilment;
}

/** A resource whose structural checks passed, paired with its parsed fulfilment + URI classification. */
export interface StructuralResource {
  readonly resource: NonNullable<Manifest['resources']>[number];
  readonly isTemplate: boolean;
  readonly variables: readonly string[];
  readonly fulfilment: StructFulfilment;
}

/** A prompt whose structural checks passed, paired with its parsed fulfilment. */
export interface StructuralPrompt {
  readonly prompt: NonNullable<Manifest['prompts']>[number];
  readonly fulfilment: StructFulfilment;
}

interface CatalogArtifactEmissionInput {
  readonly manifest: Manifest;
  readonly catalog: ConnectorCatalog | undefined;
  readonly structuralAmbientContext: StructuralAmbientContext | undefined;
  readonly structuralTools: readonly StructuralTool[];
  readonly structuralResources: readonly StructuralResource[];
  readonly structuralPrompts: readonly StructuralPrompt[];
  readonly toolUiMetaByName: ReadonlyMap<string, ArtifactMeta>;
  readonly errors: CompileError[];
}

interface CatalogArtifactEmissionResult {
  readonly artifactAmbientContext:
    | NonNullable<NonNullable<RuntimeArtifact['server']['context']>['ambient']>
    | undefined;
  readonly artifactTools: readonly ArtifactTool[];
  readonly artifactResources: readonly ArtifactResource[];
  readonly artifactPrompts: readonly ArtifactPrompt[];
  readonly declared: Record<string, DeclaredConnectorRef>;
  readonly customerEndpoints: RuntimeArtifact['customerEndpoints'];
}

/** Resolve connector references and emit catalog-dependent artifact surfaces. */
export function emitCatalogArtifactSurfaces({
  manifest,
  catalog,
  structuralAmbientContext,
  structuralTools,
  structuralResources,
  structuralPrompts,
  toolUiMetaByName,
  errors,
}: CatalogArtifactEmissionInput): CatalogArtifactEmissionResult {
  const declared: Record<string, DeclaredConnectorRef> = manifest.connectors ?? {};
  const usedAliases = new Set<string>(
    manifest.manifestVersion === '2'
      ? (manifest.server.collections ?? []).flatMap((collection) =>
          collection.source === undefined ? [] : [collection.source.connector],
        )
      : [],
  );
  const customerRouting =
    catalog === undefined ? undefined : new CustomerRoutingCollector(manifest.server.auth, errors);
  const artifactAmbientContext = emitAmbientContext(
    structuralAmbientContext,
    catalog,
    declared,
    usedAliases,
    errors,
    customerRouting,
  );
  const artifactTools: ArtifactTool[] = structuralTools.map((s) => {
    const fulfilment = emitFulfilment(s.fulfilment, catalog, declared, usedAliases, errors, {
      ...(customerRouting === undefined ? {} : { customerRouting }),
      surface: 'tool',
      confirmationRequired: requiresToolConfirmation(s.tool.annotations),
    });
    const inputSchema = withDialect(s.inputSchema);
    // A tool's `_meta.ui` merges the widget link (`resourceUri`, when a widget targets this tool) with
    // its declared `visibility` (`['app']` = UI-only). Emit `_meta` only when `ui` carries something.
    const linkedMeta = toolUiMetaByName.get(s.tool.name);
    const linkedUi = linkedMeta?.ui;
    const ui: WidgetUiMeta = {
      ...(linkedUi ?? {}),
      ...(s.tool.visibility ? { visibility: s.tool.visibility } : {}),
    };
    const meta: ArtifactMeta | undefined =
      linkedMeta !== undefined || Object.keys(ui).length > 0
        ? { ...(linkedMeta ?? {}), ...(Object.keys(ui).length > 0 ? { ui } : {}) }
        : undefined;
    return {
      name: s.tool.name,
      ...(s.tool.title ? { title: s.tool.title } : {}),
      description: s.tool.description,
      ...(s.tool.authorization
        ? {
            authorization: {
              ...(s.tool.authorization.discovery === 'public'
                ? { discovery: 'public' as const }
                : {}),
              ...(s.tool.authorization.requiredScopes
                ? {
                    requiredScopes: canonicalizeAuthorizationValues(
                      s.tool.authorization.requiredScopes,
                    ),
                  }
                : {}),
              ...(s.tool.authorization.allowedRoles
                ? {
                    allowedRoles: canonicalizeAuthorizationValues(
                      s.tool.authorization.allowedRoles,
                    ),
                  }
                : {}),
            },
          }
        : {}),
      inputSchema,
      ...(s.outputSchema ? { outputSchema: withDialect(s.outputSchema) } : {}),
      ...(s.tool.annotations ? { annotations: s.tool.annotations } : {}),
      ...(isContextProvider(s.tool) ? { contextProvider: true as const } : {}),
      fulfilment,
      ...(meta ? { _meta: meta } : {}),
    };
  });

  // Emit resources/prompts. Their connector aliases also count toward `usedAliases`, so a connector
  // referenced only by a resource/prompt is not falsely flagged as unused.
  const artifactResources: ArtifactResource[] = structuralResources.map((s) => {
    const fulfilment = emitFulfilment(s.fulfilment, catalog, declared, usedAliases, errors, {
      ...(customerRouting === undefined ? {} : { customerRouting }),
      surface: 'resource',
    });
    return {
      name: s.resource.name,
      uri: s.resource.uri,
      ...(s.resource.title ? { title: s.resource.title } : {}),
      ...(s.resource.description ? { description: s.resource.description } : {}),
      ...(s.resource.mimeType ? { mimeType: s.resource.mimeType } : {}),
      isTemplate: s.isTemplate,
      ...(s.variables.length > 0 ? { variables: s.variables } : {}),
      fulfilment,
    };
  });

  const artifactPrompts: ArtifactPrompt[] = structuralPrompts.map((s) => {
    const fulfilment = emitFulfilment(s.fulfilment, catalog, declared, usedAliases, errors, {
      ...(customerRouting === undefined ? {} : { customerRouting }),
      surface: 'prompt',
    });
    const args = s.prompt.arguments?.map((a) => ({
      name: a.name,
      ...(a.description !== undefined ? { description: a.description } : {}),
      ...(a.required !== undefined ? { required: a.required } : {}),
    }));
    return {
      name: s.prompt.name,
      ...(s.prompt.title ? { title: s.prompt.title } : {}),
      ...(s.prompt.description ? { description: s.prompt.description } : {}),
      ...(args ? { arguments: args } : {}),
      fulfilment,
    };
  });

  // Reject connector aliases that are declared but never referenced (docs/SPEC.md line 166).
  if (catalog) {
    for (const alias of Object.keys(declared)) {
      if (!usedAliases.has(alias)) {
        errors.push({
          code: 'unused_connector_alias',
          path: `connectors.${alias}`,
          message: `connector alias "${alias}" is declared but never used`,
        });
      }
    }
  }

  const customerEndpoints = customerRouting?.finalize();

  return {
    artifactAmbientContext,
    artifactTools,
    artifactResources,
    artifactPrompts,
    declared,
    customerEndpoints,
  };
}

function canonicalizeAuthorizationValues(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()))].sort();
}

export function isContextProvider(tool: object): boolean {
  return 'contextProvider' in tool && tool.contextProvider === true;
}

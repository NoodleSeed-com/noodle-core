import type { ArtifactServer, JsonSchema } from './artifact/types.js';
import type { ConnectorCatalog } from './catalog/types.js';
import type { CustomerRoutingCollector } from './customer-routing.js';
import type { CompileError } from './errors.js';
import { type DeclaredConnectorRef, emitFulfilment, withDialect } from './fulfilment-emit.js';
import {
  findExternalRef,
  parseFulfilment,
  type StructFulfilment,
} from './fulfilment-structural.js';
import type { Manifest } from './manifest/schema.js';
import { resolveSchemaUses, type SchemasMap } from './manifest/schema-refs.js';

export interface StructuralAmbientContext {
  readonly outputSchema: JsonSchema;
  readonly fulfilment: StructFulfilment;
}

/** Parse the context provider and its output schema during catalog-independent compilation. */
export function parseAmbientContext(
  manifest: Manifest,
  schemas: SchemasMap,
  errors: CompileError[],
): StructuralAmbientContext | undefined {
  const ambient = manifest.server.context?.ambient;
  if (ambient === undefined) return undefined;
  const output = resolveSchemaUses(
    ambient.outputSchema,
    schemas,
    'server.context.ambient.outputSchema',
  );
  errors.push(...output.errors);
  const externalRef = findExternalRef(output.schema, 'server.context.ambient.outputSchema');
  if (externalRef) errors.push(externalRef);
  const fulfilment = parseFulfilment(
    ambient.fulfilment,
    'server.context.ambient.fulfilment',
    errors,
  );
  return fulfilment === null ? undefined : { outputSchema: output.schema, fulfilment };
}

/** Resolve the provider against the connector catalog, enforcing its read-only contract. */
export function emitAmbientContext(
  structural: StructuralAmbientContext | undefined,
  catalog: ConnectorCatalog | undefined,
  declared: Record<string, DeclaredConnectorRef>,
  usedAliases: Set<string>,
  errors: CompileError[],
  customerRouting?: CustomerRoutingCollector,
): NonNullable<NonNullable<ArtifactServer['context']>['ambient']> | undefined {
  if (structural === undefined) return undefined;
  return {
    outputSchema: withDialect(structural.outputSchema),
    fulfilment: emitFulfilment(structural.fulfilment, catalog, declared, usedAliases, errors, {
      readOnly: true,
      ...(customerRouting === undefined ? {} : { customerRouting }),
      surface: 'ambient',
    }),
  };
}

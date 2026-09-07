import {
  type ManagedCollectionControls,
  projectManagedCollectionControls,
} from '@noodle-borg/compiler';
import type { z } from 'zod';
import type { ConnectorRef } from './connectors.js';
import { type JsonSchema, toJsonSchema } from './json-schema.js';

export interface ManagedCollectionSource {
  /** An existing connector from the enclosing server's `use` map. */
  readonly connector: ConnectorRef;
  /** Read operation implementing the normalized bounded scan contract. */
  readonly scan: string;
}

export interface ManagedCollectionInput extends ManagedCollectionControls {
  readonly title: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly record: z.ZodType;
  /** Omission makes Noodle Seed the authoritative native store. */
  readonly source?: ManagedCollectionSource;
}

export interface ManagedCollectionDeclaration extends ManagedCollectionInput {
  readonly kind: 'managedCollection';
  readonly name: string;
}

export interface ManifestManagedCollection
  extends ReturnType<typeof projectManagedCollectionControls> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly recordSchema: JsonSchema;
  readonly source?: {
    readonly connector: string;
    readonly scan: string;
  };
}

/** Declare one typed collection whose lifecycle is bound later by an authorized operator. */
export function managedCollection(
  name: string,
  input: ManagedCollectionInput,
): ManagedCollectionDeclaration {
  return { kind: 'managedCollection', name, ...input };
}

export function manifestManagedCollection(
  declaration: ManagedCollectionDeclaration,
  connectors: Readonly<Record<string, ConnectorRef>>,
): ManifestManagedCollection {
  const source = declaration.source;
  const connectorAlias =
    source === undefined
      ? undefined
      : Object.entries(connectors).find(([, connector]) => connector === source.connector)?.[0];
  if (source !== undefined && connectorAlias === undefined) {
    throw new Error(
      `managed collection "${declaration.name}" source connector must be declared in server.use`,
    );
  }
  return {
    name: declaration.name,
    title: declaration.title,
    description: declaration.description,
    schemaVersion: declaration.schemaVersion,
    recordSchema: toJsonSchema(declaration.record, 'input'),
    ...projectManagedCollectionControls(declaration),
    ...(source === undefined || connectorAlias === undefined
      ? {}
      : {
          source: {
            connector: connectorAlias,
            scan: source.scan,
          },
        }),
  };
}

export function manifestCollections(
  declarations: readonly ManagedCollectionDeclaration[] | undefined,
  connectors: Readonly<Record<string, ConnectorRef>>,
): { readonly collections?: ManifestManagedCollection[] } {
  return declarations && declarations.length > 0
    ? {
        collections: declarations.map((declaration) =>
          manifestManagedCollection(declaration, connectors),
        ),
      }
    : {};
}

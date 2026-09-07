import type { z } from 'zod';
import { type JsonSchema, toJsonSchema } from './json-schema.js';

export interface ManagedCollectionInput {
  readonly title: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly record: z.ZodType;
}

export interface ManagedCollectionDeclaration extends ManagedCollectionInput {
  readonly kind: 'managedCollection';
  readonly name: string;
}

export interface ManifestManagedCollection {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly schemaVersion: number;
  readonly recordSchema: JsonSchema;
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
): ManifestManagedCollection {
  return {
    name: declaration.name,
    title: declaration.title,
    description: declaration.description,
    schemaVersion: declaration.schemaVersion,
    recordSchema: toJsonSchema(declaration.record, 'input'),
  };
}

export function manifestCollections(
  declarations: readonly ManagedCollectionDeclaration[] | undefined,
): { readonly collections?: ManifestManagedCollection[] } {
  return declarations && declarations.length > 0
    ? { collections: declarations.map(manifestManagedCollection) }
    : {};
}

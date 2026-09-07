const CONFIG_REF = Symbol.for('noodle.authoring.configRef');
const CONFIG_REF_NAME = /^[A-Za-z0-9_]+$/;

export type ConfigRefKind = 'variable' | 'secret';

export interface ConfigRef {
  readonly [CONFIG_REF]: true;
  readonly kind: ConfigRefKind;
  readonly name: string;
  toExpression(): string;
  toString(): string;
}

export interface VariableOptions<Schema extends z.ZodType> {
  readonly schema: Schema;
  readonly default?: z.output<Schema>;
  readonly portal?: { readonly label: string; readonly help?: string; readonly group?: string };
  readonly requiredFor?: readonly string[];
}

export interface DeclaredVariableRef extends ConfigRef {
  readonly kind: 'variable';
  readonly declaration: VariableDeclarationManifest;
}

export function variable(name: string): ConfigRef;
export function variable<Schema extends z.ZodType>(
  name: string,
  options: VariableOptions<Schema>,
): DeclaredVariableRef;
export function variable(
  name: string,
  options?: VariableOptions<z.ZodType>,
): ConfigRef | DeclaredVariableRef {
  const ref = makeConfigRef('variable', name);
  if (options === undefined) return ref;
  const declaration: VariableDeclarationManifest = {
    name,
    schemaVersion: 1,
    valueSchema: toJsonSchema(options.schema, 'output', true),
    ...(Object.hasOwn(options, 'default') ? { default: options.default } : {}),
    ...(options.portal === undefined ? {} : { portal: { ...options.portal } }),
    requiredFor: [...new Set(options.requiredFor ?? [])].sort(),
  };
  const errors = validateVariableDeclaration(declaration);
  if (errors.length > 0)
    throw new Error(
      `variable("${name}") ${errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`,
    );
  return { ...ref, kind: 'variable', declaration: structuredClone(declaration) };
}

export function manifestVariables(refs: readonly DeclaredVariableRef[] | undefined): {
  variables?: VariableDeclarationManifest[];
} {
  if (refs === undefined || refs.length === 0) return {};
  return {
    variables: refs.map((ref) => {
      if (!isConfigRef(ref) || ref.kind !== 'variable' || ref.declaration === undefined)
        throw new Error('server.variables requires typed variable declarations');
      return structuredClone(ref.declaration);
    }),
  };
}

export function secret(name: string): ConfigRef {
  return makeConfigRef('secret', name);
}

export function isConfigRef(value: unknown): value is ConfigRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { readonly [CONFIG_REF]?: unknown })[CONFIG_REF] === true
  );
}

export function serializeVariableRef(ref: ConfigRef, path: string): string {
  if (ref.kind === 'variable') return ref.toExpression();
  throw new Error(`${path}: secret("${ref.name}") can only be used in connector credential slots`);
}

export function serializeSecretRef(ref: ConfigRef, path: string): string {
  if (ref.kind === 'secret') return ref.name;
  throw new Error(`${path}: variable("${ref.name}") cannot be used as a connector secret`);
}

function makeConfigRef(kind: ConfigRefKind, name: string): ConfigRef {
  if (!CONFIG_REF_NAME.test(name)) {
    throw new Error(`${kind} reference "${name}" must match [A-Za-z0-9_]+`);
  }
  return {
    [CONFIG_REF]: true,
    kind,
    name,
    toExpression() {
      if (kind !== 'variable') {
        throw new Error(`secret("${name}") can only be used in connector credential slots`);
      }
      return `\${env.${name}}`;
    },
    toString() {
      return kind === 'variable' ? `\${env.${name}}` : `secret("${name}")`;
    },
  };
}

import {
  type VariableDeclarationManifest,
  validateVariableDeclaration,
} from '@noodle-borg/compiler';
import type { z } from 'zod';
import { toJsonSchema } from './json-schema.js';

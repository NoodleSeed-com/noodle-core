import { validateJsonSchema } from '@noodle-borg/app-package';
import { z } from 'zod';
import type { CompileError } from './errors.js';

const fieldName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^(?!(?:__proto__|constructor|prototype)$)[A-Za-z_][A-Za-z0-9_]*$/);
const fieldList = z.array(fieldName).max(128);
const plainText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^<>\p{Cc}]+$/u);
export const managedCollectionControlFields = {
  management: z
    .object({ assignment: z.literal(true).optional(), notes: z.literal(true).optional() })
    .strict()
    .optional(),
  fields: z
    .record(
      fieldName,
      z.object({ label: plainText(120).optional(), help: plainText(1000).optional() }).strict(),
    )
    .optional(),
  publicFields: fieldList.optional(),
  editableFields: fieldList.optional(),
  summaryFields: fieldList.optional(),
  filterFields: fieldList.optional(),
  sortFields: fieldList.optional(),
};
const controlsSchema = z.object(managedCollectionControlFields).strict();
export interface ManagedCollectionControls {
  readonly management?:
    | { readonly assignment?: true | undefined; readonly notes?: true | undefined }
    | undefined;
  readonly fields?:
    | Readonly<
        Record<string, { readonly label?: string | undefined; readonly help?: string | undefined }>
      >
    | undefined;
  readonly publicFields?: readonly string[] | undefined;
  readonly editableFields?: readonly string[] | undefined;
  readonly summaryFields?: readonly string[] | undefined;
  readonly filterFields?: readonly string[] | undefined;
  readonly sortFields?: readonly string[] | undefined;
}

/** Validate presentation/exposure against actual record fields, independently of application names. */
export function validateManagedCollectionControls(
  controls: ManagedCollectionControls,
  schema: Readonly<Record<string, unknown>>,
  external: boolean,
  path: string,
  errors: CompileError[],
): void {
  const fail = (suffix: string, message: string) =>
    errors.push({ code: 'invalid_managed_collection', path: `${path}.${suffix}`, message });
  if (!controlsSchema.safeParse(controls).success) {
    fail('fields', 'invalid collection management or field metadata');
    return;
  }
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const key of [
    'publicFields',
    'editableFields',
    'summaryFields',
    'filterFields',
    'sortFields',
  ] as const) {
    const names = controls[key] ?? [];
    if (new Set(names).size !== names.length) fail(key, 'duplicate field reference');
    for (const name of names) {
      if (!Object.hasOwn(properties, name)) fail(key, 'field is not declared in the record schema');
      if (
        (key === 'filterFields' || key === 'sortFields') &&
        (!isObject(properties[name]) ||
          !['string', 'number', 'integer', 'boolean'].includes(String(properties[name].type)))
      )
        fail(key, 'filter and sort fields must be scalar values');
    }
  }
  for (const name of Object.keys(controls.fields ?? {}))
    if (!Object.hasOwn(properties, name)) fail('fields', 'metadata must name a declared field');
  if (
    external &&
    (controls.management !== undefined ||
      (controls.publicFields?.length ?? 0) > 0 ||
      (controls.editableFields?.length ?? 0) > 0)
  )
    fail(
      'management',
      'external reference collections cannot enable record writes, assignment or notes',
    );
  if ((controls.publicFields?.length ?? 0) > 0 && Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name !== 'string' || controls.publicFields?.includes(name)) continue;
      const property = properties[name];
      if (
        !isObject(property) ||
        !Object.hasOwn(property, 'default') ||
        validateJsonSchema(property, property.default).length > 0
      )
        fail('publicFields', 'required non-public fields need valid creation defaults');
    }
  }
  for (const property of Object.values(properties)) {
    if (
      isObject(property) &&
      Object.hasOwn(property, 'default') &&
      validateJsonSchema(property, property.default).length > 0
    )
      fail('recordSchema', 'creation default does not match its field schema');
  }
}

export function projectManagedCollectionControls(
  value: ManagedCollectionControls,
): z.infer<typeof controlsSchema> {
  return controlsSchema.parse(
    Object.fromEntries(
      Object.keys(managedCollectionControlFields).flatMap((key) => {
        const entry = value[key as keyof ManagedCollectionControls];
        return entry === undefined ? [] : [[key, structuredClone(entry)]];
      }),
    ),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

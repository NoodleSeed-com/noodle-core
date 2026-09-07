/**
 * Names for tools, connectors, schemas, resources, prompts, widgets, and flow steps use
 * lowercase letters, numbers, and underscores (docs/SPEC.md "Naming Rules").
 */
export const NAME_PATTERN = /^[a-z0-9_]+$/;

/** Connector operation reference: `<connector>.<operation>`, each segment a valid name. */
const OPERATION_REF_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Split `<connector>.<operation>` into parts, or return null if it is not well-formed. */
export function parseOperationRef(ref: string): { connector: string; operation: string } | null {
  if (!OPERATION_REF_PATTERN.test(ref)) return null;
  const dot = ref.indexOf('.');
  return { connector: ref.slice(0, dot), operation: ref.slice(dot + 1) };
}

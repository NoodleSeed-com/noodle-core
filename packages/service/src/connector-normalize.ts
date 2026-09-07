import { parse as parseYaml } from 'yaml';

const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);

interface LegacyField {
  readonly type: string;
  readonly required?: boolean;
}

type LegacyFieldMap = Readonly<Record<string, LegacyField>>;

/**
 * Upgrade connector operation field maps stored before ADR 0139. This is deliberately a service
 * recovery seam: new connector authoring still goes directly through the strict catalog parser.
 */
export function normalizePersistedConnectorsForCompile(source: string): string {
  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch {
    return source;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.connectors)) return source;

  let changed = false;
  for (const connector of parsed.connectors) {
    if (!isRecord(connector) || !isRecord(connector.operations)) continue;
    for (const operation of Object.values(connector.operations)) {
      if (!isRecord(operation)) continue;
      for (const key of ['input', 'output'] as const) {
        const fields = legacyFieldMap(operation[key]);
        if (fields === undefined) continue;
        operation[key] = fieldMapToJsonSchema(fields);
        changed = true;
      }
    }
  }

  return changed ? JSON.stringify(parsed) : source;
}

function legacyFieldMap(value: unknown): LegacyFieldMap | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  for (const [, field] of entries) {
    if (!isRecord(field) || typeof field.type !== 'string' || field.type.length === 0) {
      return undefined;
    }
    for (const [key, entry] of Object.entries(field)) {
      if (key === 'type') continue;
      if (key !== 'required' || typeof entry !== 'boolean') return undefined;
    }
  }
  return value as LegacyFieldMap;
}

function fieldMapToJsonSchema(fields: LegacyFieldMap): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, field] of Object.entries(fields)) {
    properties[name] = JSON_SCHEMA_TYPES.has(field.type) ? { type: field.type } : {};
    if (field.required === true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

import { normalizeOperationIoSchema } from '@noodle-borg/compiler';
import type {
  McpDiscoveredTool,
  McpImportAuth,
  McpImportedTool,
  McpImportSnapshot,
  SnapshotDiff,
} from './types.js';

const NAME = /^[a-z0-9_]+$/;
const MAX_TOOLS = 256;
const MAX_UPSTREAM_NAME_LENGTH = 256;
const MAX_SCHEMA_DEPTH = 64;
const MAX_SCHEMA_NODES = 50_000;

export function snapshotFromTools(input: {
  readonly endpoint: string;
  readonly name: string;
  readonly prefix?: string;
  readonly auth?: McpImportAuth;
  readonly tools: readonly McpDiscoveredTool[];
}): McpImportSnapshot {
  if (input.tools.length > MAX_TOOLS) {
    throw new Error(`upstream MCP server exposes more than ${MAX_TOOLS} tools`);
  }
  const connectorId = safeBaseName(input.name);
  const safePrefix = input.prefix === undefined ? undefined : safeBaseName(input.prefix);
  const prefix = safePrefix === undefined ? '' : `${safePrefix}_`;
  const warnings: string[] = [];
  const counts = new Map<string, number>();
  const tools: McpImportedTool[] = [];

  const discovered = input.tools.map((tool) => ({
    ...tool,
    name: upstreamName(tool.name),
  }));
  for (const tool of discovered.sort((a, b) => a.name.localeCompare(b.name))) {
    const base = `${prefix}${safeBaseName(tool.name)}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    const operationName = count === 1 ? base : `${base}_${count}`;
    if (operationName !== tool.name) {
      warnings.push(`mapped upstream tool "${tool.name}" to operation "${operationName}"`);
    }
    const inputSchema = objectSchema(tool.inputSchema, `${tool.name}.inputSchema`);
    const result = tool.outputSchema === undefined ? 'text' : 'structured';
    const outputSchema =
      tool.outputSchema === undefined
        ? textOutputSchema()
        : objectSchema(tool.outputSchema, `${tool.name}.outputSchema`);
    const operationType = 'action' as const;
    const destructive = true;
    if (tool.annotations?.readOnlyHint === true) {
      warnings.push(
        `tool "${tool.name}" claims readOnlyHint; imported as a confirmed action until the author verifies its behavior`,
      );
    } else if (tool.annotations?.readOnlyHint === undefined) {
      warnings.push(
        `tool "${tool.name}" has no readOnlyHint; imported conservatively as a confirmed action`,
      );
    }
    tools.push({
      upstreamName: tool.name,
      operationName,
      description: cleanDescription(tool.description, tool.name),
      operationType,
      destructive,
      inputSchema,
      outputSchema,
      result,
    });
  }

  return {
    formatVersion: 1,
    connectorId,
    ...(safePrefix === undefined ? {} : { prefix: safePrefix }),
    endpoint: canonicalEndpoint(input.endpoint),
    endpointVariable: `${constantName(connectorId)}_MCP_ENDPOINT`,
    originVariable: `${constantName(connectorId)}_MCP_ORIGIN`,
    ...(input.auth === undefined ? {} : { auth: input.auth }),
    tools,
    warnings: [...warnings].sort(),
  };
}

function upstreamName(value: string): string {
  if (value.length === 0 || value.length > MAX_UPSTREAM_NAME_LENGTH || /\p{Cc}/u.test(value)) {
    throw new Error(
      `upstream MCP tool name must contain 1-${MAX_UPSTREAM_NAME_LENGTH} non-control characters`,
    );
  }
  return value;
}

export function diffSnapshots(before: McpImportSnapshot, after: McpImportSnapshot): SnapshotDiff {
  const lines: string[] = [];
  const prior = new Map(before.tools.map((tool) => [tool.upstreamName, tool]));
  const next = new Map(after.tools.map((tool) => [tool.upstreamName, tool]));
  for (const name of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
    const left = prior.get(name);
    const right = next.get(name);
    if (left === undefined) lines.push(`additive: added tool: ${name}`);
    else if (right === undefined) lines.push(`breaking: removed tool: ${name}`);
    else if (stableJson(left) !== stableJson(right)) {
      const metadataOnly =
        stableJson({ ...left, description: '' }) === stableJson({ ...right, description: '' });
      lines.push(`${metadataOnly ? 'metadata-only' : 'breaking'}: changed tool: ${name}`);
    }
  }
  if (before.endpoint !== after.endpoint) lines.push('breaking: changed endpoint');
  if (stableJson(before.auth) !== stableJson(after.auth)) lines.push('breaking: changed auth');
  return { changed: lines.length > 0, lines };
}

/** Parse the system-owned drift snapshot without trusting edited local JSON. */
export function parseMcpImportSnapshot(value: unknown): McpImportSnapshot {
  if (!isRecord(value) || value.formatVersion !== 1) {
    throw new Error('MCP import snapshot has an unsupported format');
  }
  const connectorId = requiredString(value.connectorId, 'connectorId');
  if (safeBaseName(connectorId) !== connectorId) {
    throw new Error('MCP import snapshot connectorId is invalid');
  }
  const prefix = optionalString(value.prefix, 'prefix');
  if (prefix !== undefined && safeBaseName(prefix) !== prefix) {
    throw new Error('MCP import snapshot prefix is invalid');
  }
  if (!Array.isArray(value.tools) || value.tools.length > MAX_TOOLS) {
    throw new Error(`MCP import snapshot tools must contain at most ${MAX_TOOLS} entries`);
  }
  const tools = value.tools.map((candidate, index): McpImportedTool => {
    if (!isRecord(candidate)) throw new Error(`MCP import snapshot tools[${index}] is invalid`);
    const upstream = upstreamName(
      requiredString(candidate.upstreamName, `tools[${index}].upstreamName`),
    );
    const operationName = requiredString(candidate.operationName, `tools[${index}].operationName`);
    if (!NAME.test(operationName) || operationName.length > 128) {
      throw new Error(`MCP import snapshot tools[${index}].operationName is invalid`);
    }
    const description = requiredString(candidate.description, `tools[${index}].description`);
    if (description.length > 2_000) {
      throw new Error(`MCP import snapshot tools[${index}].description is too long`);
    }
    if (candidate.operationType !== 'read' && candidate.operationType !== 'action') {
      throw new Error(`MCP import snapshot tools[${index}].operationType is invalid`);
    }
    if (typeof candidate.destructive !== 'boolean') {
      throw new Error(`MCP import snapshot tools[${index}].destructive is invalid`);
    }
    if (candidate.result !== 'structured' && candidate.result !== 'text') {
      throw new Error(`MCP import snapshot tools[${index}].result is invalid`);
    }
    return {
      upstreamName: upstream,
      operationName,
      description,
      operationType: candidate.operationType,
      destructive: candidate.destructive,
      inputSchema: objectSchema(candidate.inputSchema, `tools[${index}].inputSchema`),
      outputSchema: objectSchema(candidate.outputSchema, `tools[${index}].outputSchema`),
      result: candidate.result,
    };
  });
  if (!Array.isArray(value.warnings) || value.warnings.length > MAX_TOOLS * 2) {
    throw new Error('MCP import snapshot warnings are invalid');
  }
  const warnings = value.warnings.map((warning, index) => {
    const parsed = requiredString(warning, `warnings[${index}]`);
    if (parsed.length > 2_000)
      throw new Error(`MCP import snapshot warnings[${index}] is too long`);
    return parsed;
  });
  const endpoint = canonicalEndpoint(requiredString(value.endpoint, 'endpoint'));
  const endpointVariable = `${constantName(connectorId)}_MCP_ENDPOINT`;
  const originVariable = `${constantName(connectorId)}_MCP_ORIGIN`;
  if (value.endpointVariable !== endpointVariable || value.originVariable !== originVariable) {
    throw new Error('MCP import snapshot managed binding names are invalid');
  }
  const auth = parseAuth(value.auth);
  return {
    formatVersion: 1,
    connectorId,
    ...(prefix === undefined ? {} : { prefix }),
    endpoint,
    endpointVariable,
    originVariable,
    ...(auth === undefined ? {} : { auth }),
    tools,
    warnings,
  };
}

function parseAuth(value: unknown): McpImportAuth | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.kind !== 'bearer' && value.kind !== 'apiKey')) {
    throw new Error('MCP import snapshot auth is invalid');
  }
  const secretRef = requiredString(value.secretRef, 'auth.secretRef');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(secretRef)) {
    throw new Error('MCP import snapshot auth.secretRef is invalid');
  }
  if (value.kind === 'bearer') return { kind: 'bearer', secretRef };
  const header = requiredString(value.header, 'auth.header');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(header)) {
    throw new Error('MCP import snapshot auth.header is invalid');
  }
  return { kind: 'apiKey', header, secretRef };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`MCP import snapshot ${path} is invalid`);
  }
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, path);
}

function objectSchema(value: unknown, path: string): Readonly<Record<string, unknown>> {
  inspectSchema(value, path);
  if (!isRecord(value)) throw new Error(`${path} must be a JSON Schema object`);
  const type = value.type;
  if (type !== 'object' && !(Array.isArray(type) && type.includes('object'))) {
    throw new Error(`${path} must declare an object top-level type`);
  }
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties must be boolean at the top level`);
  }
  return normalizeOperationIoSchema(value);
}

function inspectSchema(value: unknown, path: string): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new Error(`${path} exceeds the schema node limit`);
    if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${path} exceeds the schema depth limit`);
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) {
      throw new Error(`${path} contains an external $ref, which is never fetched`);
    }
    for (const child of Object.values(node)) visit(child, depth + 1);
  };
  visit(value, 0);
}

function safeBaseName(value: string): string {
  const separated = value
    .normalize('NFKD')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  const safe = /^[a-z]/.test(separated) ? separated : `tool_${separated}`;
  if (!NAME.test(safe) || safe.length === 0)
    throw new Error(`cannot derive a safe name from "${value}"`);
  return safe.slice(0, 96).replace(/_+$/g, '');
}

function constantName(value: string): string {
  return value.toUpperCase();
}

function cleanDescription(value: string | undefined, name: string): string {
  const cleaned = value
    ?.replace(/\p{Cc}/gu, (character) =>
      character === '\n' || character === '\t' ? character : '',
    )
    .trim()
    .slice(0, 2_000);
  return cleaned && cleaned.length > 0 ? cleaned : `Call upstream MCP tool "${name}".`;
}

function textOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  };
}

function canonicalEndpoint(value: string): string {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('MCP endpoint contains forbidden URL components');
  }
  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
    )
  ) {
    throw new Error('MCP endpoint must use HTTPS');
  }
  return url.toString();
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

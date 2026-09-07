import type { ElicitRequestFormParams } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchema, RuntimeArtifact } from '@noodle-borg/compiler';
import type { ConfirmationReview } from '@noodle-borg/runtime';

const MAX_CONFIRMATION_MESSAGE_CHARS = 4_000;
const MAX_REVIEW_DEPTH = 4;
const MAX_REVIEW_KEYS = 32;
const MAX_REVIEW_ARRAY_ITEMS = 12;
const MAX_REVIEW_STRING_CHARS = 240;
const SENSITIVE_FIELD =
  /authorization|cookie|password|passwd|secret|token|api.?key|credential|private.?key/i;
const CREDENTIAL_SHAPED_VALUE =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{12,}\b|\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}\b|\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b)/i;
const UNSUPPORTED_REVIEW_APPLICATORS = [
  '$ref',
  '$dynamicRef',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'dependentSchemas',
  'unevaluatedProperties',
  'contains',
  'prefixItems',
  'unevaluatedItems',
] as const;

type ArtifactTool = RuntimeArtifact['tools'][number];

export type ConfirmationElicitationPlan =
  | { readonly ok: true; readonly request: ElicitRequestFormParams }
  | { readonly ok: false; readonly reason: 'review_not_presentable' };

/** Build a portable, fail-closed form request for approving one prepared connector action. */
export function confirmationElicitationRequest(
  tool: ArtifactTool,
  review: ConfirmationReview,
): ConfirmationElicitationPlan {
  const summary = preparedReviewSummary(tool, review);
  if (!summary.complete) return { ok: false, reason: 'review_not_presentable' };
  const description = oneLine(tool.description).slice(0, MAX_REVIEW_STRING_CHARS);
  const detailed = [
    `Approve the prepared action "${tool.name}"?`,
    description.length > 0 ? `Purpose: ${description}` : '',
    'Prepared values:',
    JSON.stringify(summary.value, null, 2),
    'Approve only if these values are correct.',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
  if (detailed.length > MAX_CONFIRMATION_MESSAGE_CHARS) {
    return { ok: false, reason: 'review_not_presentable' };
  }
  return {
    ok: true,
    request: {
      mode: 'form',
      message: detailed,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Approve action',
            description: `Run ${tool.name} with the prepared values shown above.`,
            default: false,
          },
        },
        required: ['confirm'],
      },
    },
  };
}

/** MCP accept is necessary but not sufficient: the explicit form field must also be affirmative. */
export function isAffirmativeConfirmation(response: {
  readonly action: 'accept' | 'decline' | 'cancel';
  readonly content?: unknown;
}): boolean {
  return (
    response.action === 'accept' && isRecord(response.content) && response.content.confirm === true
  );
}

function preparedReviewSummary(
  tool: ArtifactTool,
  review: ConfirmationReview,
): { readonly value: Readonly<Record<string, unknown>>; readonly complete: boolean } {
  const state = { complete: true };
  const summary: Record<string, unknown> = {
    arguments: projectReviewValue(tool.inputSchema, review.input, 0, state),
  };
  if (review.action !== undefined) {
    summary.action = {
      connector: `${review.action.connectorId}@${review.action.connectorVersion}`,
      operation: review.action.operation,
      arguments: projectReviewValue(review.action.inputSchema, review.action.arguments, 0, state),
      additionalOperationCount: review.action.additionalOperationCount,
    };
  }
  if (Object.keys(review.elicited).length === 0) return { value: summary, ...state };
  const elicitationSchemas = new Map<string, JsonSchema>();
  if (tool.fulfilment.kind === 'flow') {
    for (const step of tool.fulfilment.steps) {
      if (step.kind === 'elicit') elicitationSchemas.set(step.id, step.requestedSchema);
    }
  }
  const collected = Object.create(null) as Record<string, unknown>;
  const elicitedEntries = Object.entries(review.elicited);
  for (const [id, value] of elicitedEntries.slice(0, MAX_REVIEW_KEYS)) {
    const schema = elicitationSchemas.get(id);
    if (schema === undefined) {
      state.complete = false;
      collected[id] = '[OMITTED]';
    } else {
      collected[id] = projectReviewValue(schema, value, 0, state);
    }
  }
  if (elicitedEntries.length > MAX_REVIEW_KEYS) state.complete = false;
  summary.collectedInput = collected;
  return { value: summary, ...state };
}

function projectReviewValue(
  schema: JsonSchema,
  value: unknown,
  depth: number,
  state: { complete: boolean },
): unknown {
  if (schema.writeOnly === true || schema['x-sensitive'] === true) return '[REDACTED]';
  if (UNSUPPORTED_REVIEW_APPLICATORS.some((keyword) => schema[keyword] !== undefined)) {
    state.complete = false;
    return '[OMITTED]';
  }
  if (depth >= MAX_REVIEW_DEPTH) {
    state.complete = false;
    return '[OMITTED]';
  }
  if (typeof value === 'string') {
    if (CREDENTIAL_SHAPED_VALUE.test(value)) {
      state.complete = false;
      return '[REDACTED]';
    }
    if (value.length <= MAX_REVIEW_STRING_CHARS) return value;
    state.complete = false;
    return `${value.slice(0, MAX_REVIEW_STRING_CHARS)}…`;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    const itemSchema = isRecord(schema.items) ? schema.items : {};
    const projected = value
      .slice(0, MAX_REVIEW_ARRAY_ITEMS)
      .map((item) => projectReviewValue(itemSchema, item, depth + 1, state));
    if (value.length > MAX_REVIEW_ARRAY_ITEMS) {
      state.complete = false;
      projected.push('[OMITTED]');
    }
    return projected;
  }
  if (!isRecord(value)) {
    state.complete = false;
    return '[OMITTED]';
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const projected = Object.create(null) as Record<string, unknown>;
  for (const [key, child] of Object.entries(value).slice(0, MAX_REVIEW_KEYS)) {
    if (key.length > MAX_REVIEW_STRING_CHARS) {
      state.complete = false;
      projected._omitted = true;
      continue;
    }
    const childSchema = reviewChildSchema(schema, properties, key);
    if (isRecord(childSchema) && isSensitive(childSchema)) {
      projected[key] = '[REDACTED]';
      continue;
    }
    if (SENSITIVE_FIELD.test(key)) {
      state.complete = false;
      projected[key] = '[REDACTED]';
      continue;
    }
    if (!isRecord(childSchema)) {
      state.complete = false;
      projected[key] = '[OMITTED]';
    } else {
      projected[key] = projectReviewValue(childSchema, child, depth + 1, state);
    }
  }
  if (Object.keys(value).length > MAX_REVIEW_KEYS) {
    state.complete = false;
    projected._omitted = true;
  }
  return projected;
}

function reviewChildSchema(
  schema: JsonSchema,
  properties: Readonly<Record<string, unknown>>,
  key: string,
): Readonly<Record<string, unknown>> | undefined {
  const applicable: Readonly<Record<string, unknown>>[] = [];
  if (Object.hasOwn(properties, key)) {
    const propertySchema = asReviewSchema(properties[key]);
    if (propertySchema === undefined) return undefined;
    applicable.push(propertySchema);
  }
  if (schema.patternProperties !== undefined) {
    if (!isRecord(schema.patternProperties)) return undefined;
    for (const [pattern, candidate] of Object.entries(schema.patternProperties)) {
      let matches: boolean;
      try {
        matches = new RegExp(pattern, 'u').test(key);
      } catch {
        return undefined;
      }
      if (!matches) continue;
      const patternSchema = asReviewSchema(candidate);
      if (patternSchema === undefined) return undefined;
      applicable.push(patternSchema);
    }
  }
  if (applicable.length > 0) {
    if (applicable.some((candidate) => isSensitive(candidate))) {
      return { 'x-sensitive': true };
    }
    return applicable.length === 1 ? applicable[0] : undefined;
  }
  if (schema.additionalProperties === false) return undefined;
  return asReviewSchema(schema.additionalProperties ?? true);
}

function asReviewSchema(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === true) return {};
  return isRecord(value) ? value : undefined;
}

function isSensitive(schema: Readonly<Record<string, unknown>>): boolean {
  return schema.writeOnly === true || schema['x-sensitive'] === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

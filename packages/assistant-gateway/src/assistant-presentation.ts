import { type ConfirmationReview, splitResultMeta } from '@noodle-borg/runtime';
import { isCredentialShapedAssistantText } from './assistant-sensitive-values.js';

const MAX_REVIEW_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_REVIEW_CONTAINER_ENTRIES = 128;
const MAX_OUTPUT_CONTAINER_ENTRIES = 512;
const MAX_STRING_LENGTH = 2_048;
const SENSITIVE_KEY = /(?:secret|token|api[-_]?key|password|credential|authorization|cookie)/i;

type JsonSchema = Readonly<Record<string, unknown>>;
type AssistantPresentationScalar = string | number | boolean | null;
interface AssistantPresentationArray extends ReadonlyArray<AssistantPresentationValue> {}
interface AssistantPresentationObject {
  readonly [key: string]: AssistantPresentationValue;
}
export type AssistantPresentationValue =
  | AssistantPresentationScalar
  | AssistantPresentationArray
  | AssistantPresentationObject;
type ArgumentReview =
  | { readonly ok: true; readonly value: unknown; readonly reviewSchema: JsonSchema }
  | { readonly ok: false; readonly code: 'arguments_not_presentable' };

/** Derive a client-visible review while retaining the exact validated arguments only in the store. */
export function assistantArgumentReview(schema: JsonSchema, value: unknown): ArgumentReview {
  const projected = boundedProjection(schema, value, 'REVIEW');
  return projected.complete
    ? { ok: true, value: projected.value, reviewSchema: presentationSchema(schema) }
    : { ok: false, code: 'arguments_not_presentable' };
}

/** Present the original tool input plus every elicited value that will affect prepared execution. */
export function assistantPreparedArgumentReview(
  schema: JsonSchema,
  review: ConfirmationReview,
): ArgumentReview {
  if (review.action !== undefined) {
    const reviewSchema = {
      type: 'object',
      properties: {
        action: {
          type: 'object',
          properties: {
            connector: { type: 'string' },
            operation: { type: 'string' },
            arguments: review.action.inputSchema,
            additionalOperationCount: { type: 'number' },
          },
        },
        toolInput: schema,
        elicited: { type: 'object' },
      },
    };
    return assistantArgumentReview(reviewSchema, {
      action: {
        connector: `${review.action.connectorId}@${review.action.connectorVersion}`,
        operation: review.action.operation,
        arguments: review.action.arguments,
        additionalOperationCount: review.action.additionalOperationCount,
      },
      toolInput: review.input,
      elicited: review.elicited,
    });
  }
  if (Object.keys(review.elicited).length === 0) {
    return assistantArgumentReview(schema, review.input);
  }
  return assistantArgumentReview(
    {
      type: 'object',
      properties: {
        toolInput: schema,
        elicited: { type: 'object' },
      },
      required: ['toolInput', 'elicited'],
      additionalProperties: false,
    },
    { toolInput: review.input, elicited: review.elicited },
  );
}

const CONFIRMATION_PRESENTATION = '__noodleConfirmationPresentation';

/** Attach portable display metadata to the already-persisted review JSON without changing execution input. */
export function assistantConfirmationReview(input: {
  readonly title?: string;
  readonly description: string;
  readonly review: Extract<ArgumentReview, { readonly ok: true }>;
}): Readonly<Record<string, unknown>> {
  return {
    [CONFIRMATION_PRESENTATION]: true,
    value: input.review.value,
    ...(input.title ? { title: input.title } : {}),
    description: input.description,
    reviewSchema: input.review.reviewSchema,
  };
}

/** Decode enriched and legacy persisted reviews into the additive public proposal shape. */
export function assistantConfirmationProposal(review: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(review) || review[CONFIRMATION_PRESENTATION] !== true) {
    return { arguments: review ?? {} };
  }
  return {
    arguments: review.value ?? {},
    ...(typeof review.title === 'string' ? { title: review.title } : {}),
    ...(typeof review.description === 'string' ? { description: review.description } : {}),
    ...(isRecord(review.reviewSchema) ? { reviewSchema: review.reviewSchema } : {}),
  };
}

/** Redact and bound execution output before SSE, history, audit, or model narration. */
export function assistantSafeOutput(
  schema: JsonSchema | undefined,
  value: unknown,
): AssistantPresentationValue {
  // Connector/widget metadata is a host-only side channel. It must never enter assistant narration,
  // history, SSE, audit replay, or a customer-owned renderer's model-visible result.
  const { visible } = splitResultMeta(value);
  return boundedProjection(schema, visible, 'OUTPUT').value as AssistantPresentationValue;
}

function boundedProjection(
  schema: JsonSchema | undefined,
  value: unknown,
  label: 'REVIEW' | 'OUTPUT',
): { readonly value: unknown; readonly complete: boolean } {
  const state = { complete: true };
  const maxBytes = label === 'REVIEW' ? MAX_REVIEW_BYTES : MAX_OUTPUT_BYTES;
  const maxContainerEntries =
    label === 'REVIEW' ? MAX_REVIEW_CONTAINER_ENTRIES : MAX_OUTPUT_CONTAINER_ENTRIES;
  const projected = project(schema, value, 0, new Set<object>(), state, maxContainerEntries);
  try {
    const encoded = JSON.stringify(projected);
    if (new TextEncoder().encode(encoded).byteLength <= maxBytes) {
      return { value: projected, complete: state.complete };
    }
  } catch {
    // Fall through to the safe omission marker.
  }
  return {
    value: { notice: `[${label} OMITTED: exceeds ${maxBytes / 1024} KiB]` },
    complete: false,
  };
}

function presentationSchema(schema: JsonSchema, depth = 0): JsonSchema {
  if (depth >= MAX_DEPTH) return {};
  const result: Record<string, unknown> = {};
  for (const key of ['type', 'title', 'description', 'format'] as const) {
    if (typeof schema[key] === 'string') result[key] = schema[key].slice(0, 512);
  }
  if (Array.isArray(schema.enum)) result.enum = schema.enum.slice(0, 64);
  if (Array.isArray(schema.required)) result.required = schema.required.slice(0, 128);
  if (typeof schema.additionalProperties === 'boolean') {
    result.additionalProperties = schema.additionalProperties;
  }
  if (isRecord(schema.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties)
        .slice(0, MAX_REVIEW_CONTAINER_ENTRIES)
        .map(([name, value]) => [
          name,
          isRecord(value) ? presentationSchema(value, depth + 1) : {},
        ]),
    );
  }
  if (isRecord(schema.items)) result.items = presentationSchema(schema.items, depth + 1);
  if (depth === 0) {
    try {
      if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_REVIEW_BYTES) {
        return typeof result.type === 'string' ? { type: result.type } : {};
      }
    } catch {
      return {};
    }
  }
  return result;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function project(
  schema: JsonSchema | undefined,
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  state: { complete: boolean },
  maxContainerEntries: number,
): unknown {
  if (isSensitiveSchema(schema)) return '[REDACTED]';
  if (typeof value === 'string') {
    if (isCredentialShapedAssistantText(value)) {
      state.complete = false;
      return '[REDACTED]';
    }
    if (value.length <= MAX_STRING_LENGTH) return value;
    state.complete = false;
    return `${value.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
  }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value === undefined || typeof value !== 'object') {
    state.complete = false;
    return '[UNPRESENTABLE]';
  }
  if (depth >= MAX_DEPTH) {
    state.complete = false;
    return '[TRUNCATED: maximum depth]';
  }
  if (ancestors.has(value)) {
    state.complete = false;
    return '[TRUNCATED: cycle]';
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    const itemSchema = recordValue(schema?.items);
    const result = value
      .slice(0, maxContainerEntries)
      .map((entry) => project(itemSchema, entry, depth + 1, ancestors, state, maxContainerEntries));
    if (value.length > maxContainerEntries) {
      state.complete = false;
      result.push('[TRUNCATED: more entries]');
    }
    ancestors.delete(value);
    return result;
  }

  const properties = recordValue(schema?.properties);
  const result: Record<string, unknown> = Object.create(null);
  const entries = Object.entries(value).slice(0, maxContainerEntries);
  for (const [key, entry] of entries) {
    const propertySchema = ownRecordValue(properties, key);
    if (SENSITIVE_KEY.test(key) && !isSensitiveSchema(propertySchema)) {
      state.complete = false;
      result[key] = '[REDACTED]';
    } else {
      result[key] = project(
        propertySchema,
        entry,
        depth + 1,
        ancestors,
        state,
        maxContainerEntries,
      );
    }
  }
  if (Object.keys(value).length > maxContainerEntries) {
    state.complete = false;
    result._truncated = '[TRUNCATED: more properties]';
  }
  ancestors.delete(value);
  return result;
}

function isSensitiveSchema(schema: JsonSchema | undefined): boolean {
  return schema?.writeOnly === true || schema?.['x-sensitive'] === true;
}

function recordValue(value: unknown): JsonSchema | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;
}

function ownRecordValue(record: JsonSchema | undefined, key: string): JsonSchema | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? recordValue(record[key]) : undefined;
}

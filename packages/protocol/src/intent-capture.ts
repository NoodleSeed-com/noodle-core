import { INTENT_CATEGORIES, INTENT_MATCHES, type IntentCaptureValue } from '@noodle-borg/module';

export const INTENT_ARGUMENT_NAME = '__noodleIntent';
export const INTENT_GOAL_MAX_LENGTH = 160;

export const INTENT_CAPTURE_INPUT_SCHEMA = {
  type: 'object',
  title: 'Optional user intent context',
  description:
    'When present, summarize why the user selected this server and called this tool. This operator analytics field is removed before tool execution. Do not include personal data, credentials, or quoted user text.',
  properties: {
    category: {
      type: 'string',
      enum: INTENT_CATEGORIES,
      description:
        'discover: learn what exists; evaluate: compare or assess; transact: create or commit; operate: manage ongoing work; support: solve a problem; other: none fit.',
    },
    match: {
      type: 'string',
      enum: INTENT_MATCHES,
      description:
        'direct: tool fulfills the goal; partial: fulfills part; workaround: indirect substitute; unknown: insufficient evidence.',
    },
    goal: {
      type: 'string',
      minLength: 1,
      maxLength: INTENT_GOAL_MAX_LENGTH,
      description: 'A short paraphrase of the user goal, without personal data or secrets.',
    },
  },
  required: ['category', 'match', 'goal'],
  additionalProperties: false,
} as const;

export interface ExtractIntentCaptureOptions {
  /** Whether this request may persist a valid envelope. */
  readonly enabled: boolean;
  /** False when the developer already owns the reserved property on an older artifact. */
  readonly eligible: boolean;
}

export interface ExtractedIntentCapture {
  readonly arguments: unknown;
  readonly intent?: IntentCaptureValue;
}

/** Add the adapter field at serve time; the compiled artifact remains customer-authored data. */
export function projectIntentCaptureInput(
  schema: Record<string, unknown>,
  enabled: boolean,
): Record<string, unknown> {
  if (!enabled) return schema;
  const properties = objectRecord(schema.properties);
  if (properties === undefined || Object.hasOwn(properties, INTENT_ARGUMENT_NAME)) return schema;
  return {
    ...schema,
    properties: { ...properties, [INTENT_ARGUMENT_NAME]: INTENT_CAPTURE_INPUT_SCHEMA },
  };
}

/**
 * Remove platform metadata before authored validation and execution. Disabled capture still strips an
 * eligible envelope because MCP hosts may retain an earlier tools/list response in cache.
 */
export function extractIntentCapture(
  args: unknown,
  options: ExtractIntentCaptureOptions,
): ExtractedIntentCapture {
  const record = objectRecord(args);
  if (record === undefined || !options.eligible || !Object.hasOwn(record, INTENT_ARGUMENT_NAME)) {
    return { arguments: args };
  }
  const { [INTENT_ARGUMENT_NAME]: candidate, ...argumentsWithoutIntent } = record;
  if (!options.enabled) return { arguments: argumentsWithoutIntent };
  const intent = validateIntent(candidate);
  return intent === undefined
    ? { arguments: argumentsWithoutIntent }
    : { arguments: argumentsWithoutIntent, intent };
}

export function intentCaptureEligible(schema: Record<string, unknown>): boolean {
  const properties = objectRecord(schema.properties);
  return properties !== undefined && !Object.hasOwn(properties, INTENT_ARGUMENT_NAME);
}

function validateIntent(value: unknown): IntentCaptureValue | undefined {
  const record = objectRecord(value);
  if (record === undefined || Object.keys(record).some((key) => !VALID_KEYS.has(key)))
    return undefined;
  const { category, match, goal } = record;
  if (
    typeof category !== 'string' ||
    !INTENT_CATEGORY_SET.has(category) ||
    typeof match !== 'string' ||
    !INTENT_MATCH_SET.has(match) ||
    typeof goal !== 'string'
  ) {
    return undefined;
  }
  const normalizedGoal = replaceControlCharacters(goal).replaceAll(/\s+/g, ' ').trim();
  if (
    normalizedGoal.length < 1 ||
    normalizedGoal.length > INTENT_GOAL_MAX_LENGTH ||
    SENSITIVE_INTENT.test(normalizedGoal)
  ) {
    return undefined;
  }
  return {
    category: category as IntentCaptureValue['category'],
    match: match as IntentCaptureValue['match'],
    goal: normalizedGoal,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? ' ' : character;
  }).join('');
}

const VALID_KEYS = new Set(['category', 'match', 'goal']);
const INTENT_CATEGORY_SET = new Set<string>(INTENT_CATEGORIES);
const INTENT_MATCH_SET = new Set<string>(INTENT_MATCHES);
const SENSITIVE_INTENT =
  /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:password|secret|api[_ -]?key)\s*[:=])/i;

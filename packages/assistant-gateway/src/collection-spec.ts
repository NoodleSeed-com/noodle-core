import { type JsonSchema, type RuntimeArtifact, validateJsonSchema } from '@noodle-borg/compiler';
import {
  applyCapture,
  type CaptureOutcome,
  type CollectionField,
  type CollectionLedger,
  type CollectionSpec,
} from './collection-ledger.js';

/** Platform default confirmation expiry for the WhatsApp profile (ADR 0240 decision 9). */
export const WHATSAPP_CONFIRMATION_EXPIRY_MS = 600_000;

/**
 * Derive the runtime collection spec from an opener's compiled `collect` interaction and its action's
 * input schema (ADR 0240 decision 5). Field titles, options and validation come from the action
 * schema, so the review and every candidate check use the same contract the action itself enforces;
 * the consent question is fixed runtime wording, never authored prose.
 */
export function collectionSpecFor(
  artifact: RuntimeArtifact,
  opener: string,
  profileExpiryMs: number,
): CollectionSpec | undefined {
  const interaction = artifact.toolInteractions?.[opener];
  const action = artifact.tools.find((tool) => tool.name === interaction?.action);
  if (interaction === undefined || action === undefined) return undefined;
  const properties = objectProperties(action.inputSchema);
  const fields: CollectionField[] = [];
  for (const field of interaction.fields) {
    const schema = properties[field.key];
    if (schema === undefined) return undefined;
    const options = Array.isArray(schema.enum)
      ? schema.enum.filter((option): option is string => typeof option === 'string')
      : undefined;
    fields.push({
      key: field.key,
      title: typeof schema.title === 'string' && schema.title ? schema.title : humanise(field.key),
      control: field.control,
      ...(field.private === true ? { private: true as const } : {}),
      ...(field.optional === true ? { optional: true as const } : {}),
      ...(field.control === 'select' && options !== undefined ? { options } : {}),
      schema,
    });
  }
  const brand = artifact.server.branding?.name ?? artifact.server.title;
  const authored = interaction.confirmationExpirySeconds;
  return {
    interactionId: opener,
    action: action.name,
    fields,
    consentQuestion: `Do you agree to ${brand} contacting you about this request? Yes or no.`,
    successMessage: interaction.outcome.success,
    confirmationExpiryMs:
      authored === undefined ? profileExpiryMs : Math.min(profileExpiryMs, authored * 1000),
  };
}

/**
 * Seed a freshly opened ledger from the opener's output through the interaction's `initialValues`.
 * A seeded value that is a declared field is captured only if the action schema accepts it; a seeded
 * input that is not a field rides along in the ledger values so the prepared action still receives it.
 */
export function seedCollection(
  artifact: RuntimeArtifact,
  spec: CollectionSpec,
  ledger: CollectionLedger,
  output: unknown,
  now: number,
): CollectionLedger {
  const sources = artifact.toolInteractions?.[spec.interactionId]?.initialValues ?? {};
  const record =
    typeof output === 'object' && output !== null && !Array.isArray(output)
      ? (output as Readonly<Record<string, unknown>>)
      : {};
  const outcome: Record<string, CaptureOutcome[string]> = {};
  const extra: Record<string, unknown> = {};
  for (const [target, source] of Object.entries(sources)) {
    const value = record[source.fromOutput];
    if (value === undefined || value === null) continue;
    const field = spec.fields.find((candidate) => candidate.key === target);
    if (field === undefined) extra[target] = value;
    else
      outcome[target] =
        validateJsonSchema(field.schema, value).length === 0
          ? { status: 'captured', value }
          : { status: 'invalid', reason: 'schema' };
  }
  const seeded = applyCapture(
    spec,
    { ...ledger, values: { ...extra, ...ledger.values } },
    outcome,
    now,
  );
  return seeded;
}

function humanise(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

function objectProperties(schema: JsonSchema | undefined): Readonly<Record<string, JsonSchema>> {
  const properties = schema?.properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([key, value]) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? [[key, value as JsonSchema]]
        : [],
    ),
  );
}

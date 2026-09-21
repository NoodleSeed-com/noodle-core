import type { ArtifactCollectInteraction, ArtifactTool, JsonSchema } from '../artifact/types.js';
import type { CompileError } from '../errors.js';
import type { CollectControl, ToolInteractionManifest } from './interaction-schema.js';

/**
 * Compile-time checks for the `collect` interaction block (ADR 0240). Every field must be an input of
 * the action it prepares with a control its schema can honor; every required action input must be
 * collected or seeded from the opener's output; consent is a single fixed-true boolean; and the
 * developer may only shorten the confirmation expiry within the platform ceiling. Valid blocks are
 * emitted keyed by opener tool as system-owned artifact data, never onto the MCP-visible descriptor.
 */

/** The 24-hour platform ceiling (email profile default); every profile default sits below it. */
const MAX_CONFIRMATION_EXPIRY_SECONDS = 86_400;

/** Only Core v2 tools carry `interaction`; a v1 tool list satisfies this shape with none declared. */
interface InteractionCarrier {
  readonly name: string;
  readonly interaction?: ToolInteractionManifest | undefined;
}

export function compileToolInteractions(
  tools: readonly InteractionCarrier[],
  artifactTools: readonly ArtifactTool[],
  errors: CompileError[],
): Readonly<Record<string, ArtifactCollectInteraction>> | undefined {
  const byName = new Map(artifactTools.map((tool) => [tool.name, tool]));
  const emitted: Record<string, ArtifactCollectInteraction> = {};
  tools.forEach((tool, index) => {
    if (tool.interaction === undefined) return;
    const opener = byName.get(tool.name);
    if (opener === undefined) return; // a structural error on this tool was already recorded
    const before = errors.length;
    validateCollect(tool.interaction, opener, byName, `tools.${index}.interaction`, errors);
    if (errors.length === before) emitted[tool.name] = toArtifact(tool.interaction);
  });
  return Object.keys(emitted).length > 0 ? emitted : undefined;
}

function validateCollect(
  interaction: ToolInteractionManifest,
  opener: ArtifactTool,
  byName: ReadonlyMap<string, ArtifactTool>,
  path: string,
  errors: CompileError[],
): void {
  const action = byName.get(interaction.action);
  if (action === undefined) {
    errors.push({
      code: 'interaction_action_invalid',
      path: `${path}.action`,
      message: `interaction action "${interaction.action}" is not a declared tool`,
    });
    return;
  }
  if (action.annotations?.confirm !== true || action.annotations?.readOnlyHint === true) {
    errors.push({
      code: 'interaction_action_invalid',
      path: `${path}.action`,
      message: `interaction action "${action.name}" must set { confirm: true } and must not be read-only`,
    });
    return;
  }
  const inputs = objectProperties(action.inputSchema);
  const required = new Set(stringList(action.inputSchema.required));
  const outputs = objectProperties(opener.outputSchema);
  const covered = new Set<string>();
  let consents = 0;

  interaction.fields.forEach((field, index) => {
    const fieldPath = `${path}.fields.${index}`;
    const property = inputs[field.key];
    if (property === undefined) {
      errors.push({
        code: 'interaction_field_unknown',
        path: fieldPath,
        message: `field "${field.key}" is not an input of action "${action.name}"`,
      });
      return;
    }
    covered.add(field.key);
    if (field.control === 'consent') consents += 1;
    const mismatch = controlMismatch(field.control, property);
    if (mismatch !== undefined) {
      errors.push({
        code: 'interaction_field_control_mismatch',
        path: fieldPath,
        message: `field "${field.key}" uses control "${field.control}" but its input schema ${mismatch}`,
      });
    }
    if (field.optional === true) {
      if (required.has(field.key) && !acceptsEmptyString(property)) {
        errors.push({
          code: 'interaction_field_missing',
          path: fieldPath,
          message: `optional field "${field.key}" is required by action "${action.name}" and rejects the empty value; make the property optional or let it accept ""`,
        });
      }
    } else if (!required.has(field.key)) {
      errors.push({
        code: 'interaction_field_missing',
        path: fieldPath,
        message: `field "${field.key}" is not required by action "${action.name}"; mark it optional: true or require it`,
      });
    }
  });
  if (consents > 1) {
    errors.push({
      code: 'interaction_consent_invalid',
      path: `${path}.fields`,
      message: 'a collect interaction poses at most one consent question',
    });
  }

  for (const [target, source] of Object.entries(interaction.initialValues ?? {})) {
    const valuePath = `${path}.initialValues.${target}`;
    if (inputs[target] === undefined) {
      errors.push({
        code: 'interaction_initial_value_unknown',
        path: valuePath,
        message: `initial value "${target}" is not an input of action "${action.name}"`,
      });
    } else {
      covered.add(target);
    }
    if (outputs[source.fromOutput] === undefined) {
      errors.push({
        code: 'interaction_initial_value_unknown',
        path: `${valuePath}.fromOutput`,
        message: `initial value "${target}" reads "${source.fromOutput}", which "${opener.name}" does not output`,
      });
    }
  }

  for (const key of required) {
    if (covered.has(key)) continue;
    errors.push({
      code: 'interaction_field_missing',
      path: `${path}.fields`,
      message: `required input "${key}" of action "${action.name}" is neither a field nor an initial value`,
    });
  }

  const seconds = interaction.confirmationExpiry?.seconds;
  if (
    seconds !== undefined &&
    !(Number.isInteger(seconds) && seconds >= 1 && seconds <= MAX_CONFIRMATION_EXPIRY_SECONDS)
  ) {
    errors.push({
      code: 'interaction_expiry_invalid',
      path: `${path}.confirmationExpiry.seconds`,
      message: `confirmationExpiry.seconds must be a whole number from 1 to ${MAX_CONFIRMATION_EXPIRY_SECONDS}`,
    });
  }
}

/** Why `control` cannot render `property`, or undefined when the schema supports it. */
function controlMismatch(control: CollectControl, property: JsonSchema): string | undefined {
  switch (control) {
    case 'consent':
      return property.type === 'boolean' && isFixedTrue(property)
        ? undefined
        : 'is not a boolean fixed to true';
    case 'select':
      return property.type === 'string' && isStringEnum(property.enum)
        ? undefined
        : 'is not an enum of strings';
    case 'email':
      if (property.type !== 'string') return 'is not a string';
      return property.format === undefined || property.format === 'email'
        ? undefined
        : `declares format "${String(property.format)}"`;
    default:
      return property.type === 'string' ? undefined : 'is not a string';
  }
}

function isFixedTrue(property: JsonSchema): boolean {
  if (property.const === true) return true;
  return Array.isArray(property.enum) && property.enum.length === 1 && property.enum[0] === true;
}

function isStringEnum(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string');
}

/**
 * Whether `""` satisfies a string property, so an optional field the action still requires can be
 * submitted blank. Any format, a positive minLength, or a pattern/enum/const rejecting `""` means no.
 */
function acceptsEmptyString(property: JsonSchema): boolean {
  if (property.type !== 'string' || property.format !== undefined) return false;
  if (typeof property.minLength === 'number' && property.minLength > 0) return false;
  if (property.const !== undefined && property.const !== '') return false;
  if (Array.isArray(property.enum) && !property.enum.includes('')) return false;
  return typeof property.pattern === 'string' ? patternMatchesEmpty(property.pattern) : true;
}

function patternMatchesEmpty(pattern: string): boolean {
  for (const flags of ['u', '']) {
    try {
      return new RegExp(pattern, flags).test('');
    } catch {
      // An invalid pattern under this flag set; try the next, then fail closed.
    }
  }
  return false;
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

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function toArtifact(interaction: ToolInteractionManifest): ArtifactCollectInteraction {
  return {
    kind: 'collect',
    action: interaction.action,
    fields: interaction.fields.map((field) => ({
      key: field.key,
      control: field.control,
      ...(field.private === true ? { private: true as const } : {}),
      ...(field.optional === true ? { optional: true as const } : {}),
    })),
    ...(interaction.initialValues === undefined
      ? {}
      : { initialValues: interaction.initialValues }),
    review: 'all',
    outcome: { success: interaction.outcome.success },
    ...(interaction.confirmationExpiry === undefined
      ? {}
      : { confirmationExpirySeconds: interaction.confirmationExpiry.seconds }),
  };
}

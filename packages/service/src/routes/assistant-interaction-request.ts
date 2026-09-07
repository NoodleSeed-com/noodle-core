import type { AssistantInteractionRecord } from '@noodle-borg/assistant-gateway/portable';
import { validateJsonSchemaWithDefaults } from '@noodle-borg/compiler';
import { assistantInteractionRequestSchema } from '@noodle-borg/wire-contracts';

export type InteractionAction = 'accept' | 'decline' | 'cancel';

export interface InteractionResponse {
  readonly id: string;
  readonly action: InteractionAction;
  readonly content?: unknown;
  readonly suggestions?: true | undefined;
}

export function validateInputContent(
  interaction: Extract<AssistantInteractionRecord, { readonly kind: 'input' }>,
  content: unknown,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) {
    return { ok: false };
  }
  const properties = interaction.requestedSchema.properties;
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return { ok: false };
  }
  if (Object.keys(content).some((key) => !Object.hasOwn(properties, key))) {
    return { ok: false };
  }
  const validated = validateJsonSchemaWithDefaults(interaction.requestedSchema, content);
  return validated.issues.length === 0 ? { ok: true, value: validated.value } : { ok: false };
}

export function parseInteractionResponse(
  value: unknown,
  legacyAcceptOnly: boolean,
):
  | { readonly ok: true; readonly value: InteractionResponse }
  | { readonly ok: false; readonly error: string } {
  if (legacyAcceptOnly) {
    const candidate = (value as { readonly id?: unknown } | null)?.id;
    return typeof candidate === 'string'
      ? { ok: true, value: { id: candidate, action: 'accept' } }
      : { ok: false, error: '"id" is required' };
  }
  const parsed = assistantInteractionRequestSchema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: 'invalid interaction response' };
}

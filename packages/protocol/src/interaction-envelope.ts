import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ElicitationResponse } from '@noodle-borg/runtime';

export function extractElicitationResponses(
  value: unknown,
  requestMeta: unknown,
  useArgumentEnvelope: boolean,
): {
  readonly arguments: unknown;
  readonly responses: Readonly<Record<string, ElicitationResponse>>;
} {
  if (!useArgumentEnvelope) {
    return { arguments: value, responses: interactionResponsesFromMeta(requestMeta) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { arguments: value, responses: interactionResponsesFromMeta(requestMeta) };
  }
  const input = value as Record<string, unknown>;
  const { __noodleInteraction, ...toolArguments } = input;
  if (
    __noodleInteraction === null ||
    typeof __noodleInteraction !== 'object' ||
    Array.isArray(__noodleInteraction)
  ) {
    return { arguments: toolArguments, responses: interactionResponsesFromMeta(requestMeta) };
  }
  const candidate = (__noodleInteraction as Record<string, unknown>).responses;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { arguments: toolArguments, responses: interactionResponsesFromMeta(requestMeta) };
  }
  const responses = {
    ...interactionResponsesFromMeta(requestMeta),
    ...parseElicitationResponses(candidate),
  };
  return { arguments: toolArguments, responses };
}

export function toolUsesPortableInteractionArgument(
  tool: RuntimeArtifact['tools'][number] | undefined,
) {
  if (
    tool?.fulfilment.kind !== 'flow' ||
    !tool.fulfilment.steps.some((step) => step.kind === 'elicit')
  ) {
    return false;
  }
  const properties = tool.inputSchema.properties;
  return !(
    properties !== null &&
    typeof properties === 'object' &&
    Object.hasOwn(properties, '__noodleInteraction')
  );
}

function interactionResponsesFromMeta(
  value: unknown,
): Readonly<Record<string, ElicitationResponse>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const noodle = (value as Record<string, unknown>).noodle;
  if (noodle === null || typeof noodle !== 'object' || Array.isArray(noodle)) return {};
  const interaction = (noodle as Record<string, unknown>).interaction;
  if (interaction === null || typeof interaction !== 'object' || Array.isArray(interaction))
    return {};
  return parseElicitationResponses((interaction as Record<string, unknown>).responses);
}

function parseElicitationResponses(value: unknown): Readonly<Record<string, ElicitationResponse>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const responses: Record<string, ElicitationResponse> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const response = raw as Record<string, unknown>;
    if (response.action === 'decline' || response.action === 'cancel') {
      responses[id] = { action: response.action };
    } else if (response.action === 'accept') {
      responses[id] = {
        action: 'accept',
        ...(Object.hasOwn(response, 'content') ? { content: response.content } : {}),
      };
    }
  }
  return responses;
}

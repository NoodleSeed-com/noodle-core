import type { RuntimeArtifact } from '@noodle-borg/compiler';
import type { ToolDescriptor } from './mapping.js';

/** Reserved, surface-neutral MCP adapter for an invocation's immutable context snapshot. */
export const CONTEXT_TOOL_NAME = 'noodle_context';

const PREFERENCE_SOURCE_SCHEMA = {
  type: 'string',
  enum: ['user-preference', 'client-hint', 'server-default', 'platform-default'],
} as const;

export const CONTEXT_TOOL_DESCRIPTOR: ToolDescriptor = {
  name: CONTEXT_TOOL_NAME,
  description:
    'Read the server-resolved current date, time, locale, time zone, optional client-provided location, and ambient application facts for this invocation.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    properties: {
      temporal: {
        type: 'object',
        properties: {
          instant: { type: 'string' },
          localDate: { type: 'string' },
          localTime: { type: 'string' },
          utcOffset: { type: 'string' },
          weekday: { type: 'string' },
          timeZone: { type: 'string' },
          locale: { type: 'string' },
          source: {
            type: 'object',
            properties: {
              locale: PREFERENCE_SOURCE_SCHEMA,
              timeZone: PREFERENCE_SOURCE_SCHEMA,
            },
            required: ['locale', 'timeZone'],
            additionalProperties: false,
          },
        },
        required: [
          'instant',
          'localDate',
          'localTime',
          'utcOffset',
          'weekday',
          'timeZone',
          'locale',
          'source',
        ],
        additionalProperties: false,
      },
      ambientStatus: {
        type: 'string',
        enum: ['not_configured', 'available', 'unavailable'],
      },
      location: {
        type: 'object',
        properties: {
          latitude: { type: 'number', minimum: -90, maximum: 90 },
          longitude: { type: 'number', minimum: -180, maximum: 180 },
          city: { type: 'string' },
          region: { type: 'string' },
          country: { type: 'string' },
          timeZone: { type: 'string' },
          source: { type: 'string', enum: ['client-hint'] },
        },
        required: ['latitude', 'longitude', 'source'],
        additionalProperties: false,
      },
      ambient: {},
    },
    required: ['temporal', 'ambientStatus'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export function artifactDeclaresContext(artifact: RuntimeArtifact): boolean {
  return (
    artifact.source?.coreVersion !== '2' &&
    artifact.server?.context !== undefined &&
    !artifact.tools.some((tool) => tool.contextProvider === true)
  );
}

/** Fail explicitly rather than shadowing either an author tool or the platform context adapter. */
export function assertNoContextToolCollision(artifact: RuntimeArtifact): void {
  if (
    artifactDeclaresContext(artifact) &&
    artifact.tools.some((tool) => tool.name === CONTEXT_TOOL_NAME)
  ) {
    throw new Error(
      `tool name "${CONTEXT_TOOL_NAME}" is reserved for the Noodle Seed invocation-context adapter`,
    );
  }
}

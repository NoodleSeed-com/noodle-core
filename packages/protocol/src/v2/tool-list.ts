import type { ToolsListResult } from '../mapping.js';

const LEGACY_INTERACTION_ARGUMENT = '__noodleInteraction';

/** Modern descriptors omit the legacy-only portable retry argument and use stable name ordering. */
export function shapeModernToolsList(result: ToolsListResult): ToolsListResult {
  return {
    ...result,
    tools: result.tools.map((tool) => {
      const properties = tool.inputSchema.properties;
      if (
        properties === null ||
        typeof properties !== 'object' ||
        Array.isArray(properties) ||
        !Object.hasOwn(properties, LEGACY_INTERACTION_ARGUMENT)
      ) {
        return tool;
      }
      const { [LEGACY_INTERACTION_ARGUMENT]: _legacy, ...modernProperties } = properties as Record<
        string,
        unknown
      >;
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: modernProperties,
        },
      };
    }),
  };
}

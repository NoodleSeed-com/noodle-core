import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { runMcpToolInteraction } from './tool-interaction.js';

export function stoppedToolResult(
  action: 'decline' | 'cancel',
  subject: 'requested input' | 'action',
): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `User ${action === 'decline' ? 'declined' : 'cancelled'} the ${subject}.`,
      },
    ],
    isError: true,
  } as CallToolResult;
}

export function interactionUnavailableToolResult(
  toolName: string,
  result: Extract<
    Awaited<ReturnType<typeof runMcpToolInteraction>>,
    { readonly status: 'interaction_unavailable' }
  >,
): CallToolResult {
  const { interaction } = result;
  const text =
    interaction === 'confirmation'
      ? 'This action was not run because this chat cannot present the required confirmation. Use a host that supports confirmation, or ask the app developer to enable the explicit host confirmation fallback.'
      : 'This action is waiting for a few details. Complete the form in this app, or gather the requested fields and retry this tool with the structured continuation provided.';
  return {
    isError: true,
    content: [{ type: 'text', text }],
    structuredContent: {
      code: 'interaction_unavailable',
      interaction,
      executed: false,
      ...(result.request === undefined
        ? {}
        : {
            recoverable: true,
            request: result.request,
            retry: {
              tool: toolName,
              argument: '__noodleInteraction.responses',
            },
          }),
    },
    ...(result.request === undefined
      ? {}
      : {
          _meta: {
            noodle: {
              interaction: {
                tool: toolName,
                responses: result.responses ?? {},
              },
            },
          },
        }),
  };
}

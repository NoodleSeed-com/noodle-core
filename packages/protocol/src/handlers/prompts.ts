import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type GetPromptResult as SdkGetPromptResult,
  type ListPromptsResult as SdkListPromptsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { type ExecuteDeps, executePrompt } from '@noodle-borg/runtime';
import { mapPromptMessages, mapPromptsList } from '../mapping.js';
import {
  estimateTokens,
  executionErrorObservation,
  notify,
  type ObservedOutcome,
  type ProtocolObservation,
} from '../observation.js';
import type { ProtocolRequestContext } from '../sdk-server.js';

export function registerPrompts(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
): void {
  server.setRequestHandler(
    ListPromptsRequestSchema,
    () => mapPromptsList(artifact) as SdkListPromptsResult,
  );

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const observe = (
      outcome: ObservedOutcome,
      extra: Pick<ProtocolObservation, 'errorKind' | 'outputTokensEst' | 'connector'> = {},
    ): void => notify(context, { method: 'prompts/get', promptName: name, outcome, ...extra });

    const prompt = (artifact.prompts ?? []).find((p) => p.name === name);
    if (!prompt) {
      observe('mcp_error', { errorKind: 'unknown_prompt' });
      throw new McpError(ErrorCode.InvalidParams, `unknown prompt "${name}"`);
    }

    for (const argument of prompt.arguments ?? []) {
      if (argument.required && args?.[argument.name] === undefined) {
        observe('mcp_error', { errorKind: 'invalid_params' });
        throw new McpError(ErrorCode.InvalidParams, `missing required argument "${argument.name}"`);
      }
    }

    const result = await executePrompt(artifact, name, args ?? {}, deps);
    if (!result.ok) {
      observe('mcp_error', executionErrorObservation(result.error));
      throw new McpError(ErrorCode.InternalError, result.error.message);
    }
    const mapped = mapPromptMessages(result.output, prompt.description) as SdkGetPromptResult;
    observe('ok', { outputTokensEst: estimateTokens(result.output) });
    return mapped;
  });
}

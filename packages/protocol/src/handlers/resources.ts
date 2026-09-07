import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ListResourcesResult as SdkListResourcesResult,
  type ListResourceTemplatesResult as SdkListResourceTemplatesResult,
  type ReadResourceResult as SdkReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { RuntimeArtifact } from '@noodle-borg/compiler';
import { type ExecuteDeps, executeResource } from '@noodle-borg/runtime';
import { parseUriTemplate } from '@noodle-borg/uri-template';
import { RESOURCE_NOT_FOUND } from '../error-codes.js';
import { mapResourceContents, mapResourcesList, mapResourceTemplatesList } from '../mapping.js';
import { estimateTokens, executionErrorObservation, notify } from '../observation.js';
import type { ProtocolRequestContext } from '../sdk-server.js';

export function registerResources(
  server: Server,
  artifact: RuntimeArtifact,
  deps: ExecuteDeps,
  context: ProtocolRequestContext,
): void {
  server.setRequestHandler(
    ListResourcesRequestSchema,
    () => mapResourcesList(artifact) as SdkListResourcesResult,
  );
  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    () => mapResourceTemplatesList(artifact) as SdkListResourceTemplatesResult,
  );

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    for (const resource of artifact.resources ?? []) {
      const variables = matchResourceUri(resource.uri, resource.isTemplate, uri);
      if (variables === null) continue;
      const result = await executeResource(artifact, resource.name, variables, deps);
      if (!result.ok) {
        notify(context, {
          method: 'resources/read',
          resourceName: resource.name,
          outcome: 'mcp_error',
          ...executionErrorObservation(result.error),
        });
        throw new McpError(ErrorCode.InternalError, result.error.message);
      }
      const mapped = mapResourceContents(
        uri,
        resource.mimeType,
        result.output,
        resource._meta,
        context.widgetDomain,
      ) as SdkReadResourceResult;
      notify(context, {
        method: 'resources/read',
        resourceName: resource.name,
        outcome: 'ok',
        outputTokensEst: estimateTokens(result.output),
      });
      return mapped;
    }
    notify(context, {
      method: 'resources/read',
      outcome: 'mcp_error',
      errorKind: 'resource_not_found',
    });
    throw new McpError(RESOURCE_NOT_FOUND, `resource not found: ${uri}`);
  });
}

/** Return the URI variables a resource matches, or `null` if it does not match the requested URI. */
function matchResourceUri(
  pattern: string,
  isTemplate: boolean,
  uri: string,
): Record<string, string> | null {
  if (!isTemplate) return pattern === uri ? {} : null;
  const parsed = parseUriTemplate(pattern);
  return parsed.ok && parsed.value.kind === 'template' ? parsed.value.match(uri) : null;
}

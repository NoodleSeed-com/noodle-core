import type { ArtifactTool } from '@noodle-borg/compiler';
import { evaluateToolAuthorization, type ToolAuthorizationCaller } from './tool-authorization.js';

/** The hosting plane opts into schemes only for the resolved mixed customer policy. */
export type ToolAuthenticationPolicy = 'mixed-customer';

export type ToolSecurityScheme =
  | { readonly type: 'noauth' }
  | { readonly type: 'oauth2'; readonly scopes: readonly string[] };

/** Descriptor publication only; execution and non-MCP capability filters remain authorization-only. */
export function filterDiscoverableTools(
  tools: readonly ArtifactTool[],
  caller: ToolAuthorizationCaller | undefined,
): readonly ArtifactTool[] {
  return tools.filter(
    (tool) =>
      tool.authorization?.discovery === 'public' ||
      evaluateToolAuthorization(tool.authorization, caller).allow,
  );
}

export function toolSecuritySchemes(
  tool: Pick<ArtifactTool, 'authorization'>,
): readonly ToolSecurityScheme[] {
  return tool.authorization === undefined
    ? [{ type: 'noauth' }]
    : [{ type: 'oauth2', scopes: tool.authorization.requiredScopes ?? [] }];
}

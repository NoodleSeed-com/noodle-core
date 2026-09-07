import type { ArtifactTool, ArtifactToolAuthorization } from '@noodle-borg/compiler';

export { TOOL_AUTHORIZATION_DENIED } from './error-codes.js';

export interface ToolAuthorizationCaller {
  readonly scopes?: readonly string[];
  readonly roles?: readonly string[];
}

export type ToolAuthorizationDecision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: 'authentication_required' | 'role_required' }
  | {
      readonly allow: false;
      readonly reason: 'insufficient_scope';
      readonly requiredScopes: readonly string[];
    };

export type ToolAuthorizationRuleClass = 'unrestricted' | 'scopes' | 'roles' | 'scopes_and_roles';

/** Evaluate one normalized per-tool rule against canonical verified caller claims. */
export function evaluateToolAuthorization(
  authorization: ArtifactToolAuthorization | undefined,
  caller: ToolAuthorizationCaller | undefined,
): ToolAuthorizationDecision {
  if (authorization === undefined) return { allow: true };
  if (caller === undefined) return { allow: false, reason: 'authentication_required' };

  if (
    authorization.allowedRoles !== undefined &&
    !authorization.allowedRoles.some((role) => (caller.roles ?? []).includes(role))
  ) {
    return { allow: false, reason: 'role_required' };
  }
  if (
    authorization.requiredScopes !== undefined &&
    !authorization.requiredScopes.every((scope) => (caller.scopes ?? []).includes(scope))
  ) {
    return {
      allow: false,
      reason: 'insufficient_scope',
      requiredScopes: authorization.requiredScopes,
    };
  }
  return { allow: true };
}

/** Preserve artifact order while removing every tool the current caller cannot use. */
export function filterAuthorizedTools(
  tools: readonly ArtifactTool[],
  caller: ToolAuthorizationCaller | undefined,
): readonly ArtifactTool[] {
  return tools.filter((tool) => evaluateToolAuthorization(tool.authorization, caller).allow);
}

export function toolAuthorizationRuleClass(
  authorization: ArtifactToolAuthorization | undefined,
): ToolAuthorizationRuleClass {
  if (authorization?.requiredScopes !== undefined && authorization.allowedRoles !== undefined) {
    return 'scopes_and_roles';
  }
  if (authorization?.requiredScopes !== undefined) return 'scopes';
  if (authorization?.allowedRoles !== undefined) return 'roles';
  return 'unrestricted';
}

/** Stable opaque identifier for logs; author-declared scope and role values never enter observations. */
export function toolAuthorizationRuleFingerprint(
  authorization: ArtifactToolAuthorization | undefined,
): string {
  const source =
    authorization === undefined
      ? 'unrestricted'
      : JSON.stringify({
          scopes: authorization.requiredScopes ?? [],
          roles: authorization.allowedRoles ?? [],
        });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

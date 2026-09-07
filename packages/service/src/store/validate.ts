/**
 * Slug/name/domain validation shared by every store backend. Extracted verbatim from `store.ts`
 * (which re-exports everything here) so backend modules can import validators without a runtime
 * import cycle through the store aggregate.
 */
import { validateSlug } from '@noodle-borg/control-plane/portable';
import type { ConfigScope, TenantRef } from '../store.js';

export {
  DOMAIN_PATTERN,
  SLUG_PATTERN,
  validateDomain,
  validateOrgMembershipDomain,
  validateOrgRole,
  validateSignupAllowlistKind,
  validateSlug,
} from '@noodle-borg/control-plane/portable';

/** Minted deployment id shape (`mintDeploymentId`): a slug plus a short hex suffix; safe as a filename. */
export const DEPLOYMENT_ID_PATTERN = /^[a-z0-9-]+$/;
export const CONFIG_NAME_PATTERN = /^[A-Za-z0-9_]+$/;

export function validateTenantRef(ref: TenantRef): TenantRef {
  return {
    org: validateSlug('org', ref.org),
    app: validateSlug('app', ref.app),
    env: validateSlug('env', ref.env),
  };
}

export function validateConfigName(name: string): string {
  if (!CONFIG_NAME_PATTERN.test(name)) {
    throw new Error(`invalid config name "${name}"; use letters, numbers, and underscores only`);
  }
  return name;
}

export function validateConfigScope(scope: ConfigScope): ConfigScope {
  if (scope.level === 'org') return { level: 'org', org: validateSlug('org', scope.org) };
  if (scope.level === 'app') {
    return {
      level: 'app',
      org: validateSlug('org', scope.org),
      app: validateSlug('app', scope.app),
    };
  }
  return {
    level: 'env',
    org: validateSlug('org', scope.org),
    app: validateSlug('app', scope.app),
    env: validateSlug('env', scope.env),
  };
}

/** Validate identifiers represented as positive integers rather than zero, negative values, or floats. */
export function validatePositiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid ${name} "${value}"; must be a positive integer`);
  }
  return value;
}

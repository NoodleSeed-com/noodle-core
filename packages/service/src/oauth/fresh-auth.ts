import { FRESH_AUTH_SCOPE, SIGNUP_INTENT_SCOPE } from '@noodle-borg/module';

export { FRESH_AUTH_SCOPE, SIGNUP_INTENT_SCOPE };
export function requestsFreshAuthentication(scope: string | undefined): boolean {
  return scopeTokens(scope).includes(FRESH_AUTH_SCOPE);
}

export function publicOAuthScope(scope: string | undefined): string | undefined {
  const publicScopes = scopeTokens(scope).filter(
    (value) => value !== FRESH_AUTH_SCOPE && value !== SIGNUP_INTENT_SCOPE,
  );
  return publicScopes.length === 0 ? undefined : publicScopes.join(' ');
}

function scopeTokens(scope: string | undefined): readonly string[] {
  return scope?.split(' ').filter((value) => value.length > 0) ?? [];
}

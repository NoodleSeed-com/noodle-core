import type { TenantAuthConfig, TenantBridgeAuthConfig } from './store.js';

const MANAGED_VARIABLE_RE = /\$\{env\.([A-Za-z0-9_]+)\}/g;

function managedVariableNamesInString(value: string): readonly string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(MANAGED_VARIABLE_RE)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names].sort();
}

export function resolveManagedVariablesInString(
  value: string,
  variables: Readonly<Record<string, string>>,
): string {
  return value.replace(MANAGED_VARIABLE_RE, (_match, name: string) => {
    const resolved = variables[name];
    if (resolved === undefined) throw new Error(`missing managed variable "${name}"`);
    return resolved;
  });
}

export function serverAuthVariableBindings(auth: TenantAuthConfig | undefined): readonly string[] {
  if (auth?.kind !== 'bridge') return [];
  const names = new Set<string>();
  collectOptional(auth.verifyUrl, names);
  collectOptional(auth.authorizeUrl, names);
  collectOptional(auth.projectId, names);
  collectOptional(auth.apiKey, names);
  collectOptional(auth.authDomain, names);
  collectOptional(auth.appId, names);
  collectOptional(auth.tenantId, names);
  collectOptional(auth.audience, names);
  collectOptional(auth.clientId, names);
  collectOptional(auth.tokenUrl, names);
  for (const scope of auth.scopes ?? []) collectOptional(scope, names);
  return [...names].sort();
}

export function resolveTenantBridgeAuthVariables(
  auth: TenantBridgeAuthConfig,
  variables: Readonly<Record<string, string>>,
): TenantBridgeAuthConfig {
  return {
    ...auth,
    ...(auth.verifyUrl !== undefined
      ? { verifyUrl: resolveManagedVariablesInString(auth.verifyUrl, variables) }
      : {}),
    ...(auth.authorizeUrl !== undefined
      ? { authorizeUrl: resolveManagedVariablesInString(auth.authorizeUrl, variables) }
      : {}),
    ...(auth.projectId !== undefined
      ? { projectId: resolveManagedVariablesInString(auth.projectId, variables) }
      : {}),
    ...(auth.apiKey !== undefined
      ? { apiKey: resolveManagedVariablesInString(auth.apiKey, variables) }
      : {}),
    ...(auth.authDomain !== undefined
      ? { authDomain: resolveManagedVariablesInString(auth.authDomain, variables) }
      : {}),
    ...(auth.appId !== undefined
      ? { appId: resolveManagedVariablesInString(auth.appId, variables) }
      : {}),
    ...(auth.tenantId !== undefined
      ? { tenantId: resolveManagedVariablesInString(auth.tenantId, variables) }
      : {}),
    ...(auth.audience !== undefined
      ? { audience: resolveManagedVariablesInString(auth.audience, variables) }
      : {}),
    ...(auth.clientId !== undefined
      ? { clientId: resolveManagedVariablesInString(auth.clientId, variables) }
      : {}),
    ...(auth.tokenUrl !== undefined
      ? { tokenUrl: resolveManagedVariablesInString(auth.tokenUrl, variables) }
      : {}),
    ...(auth.scopes !== undefined
      ? { scopes: auth.scopes.map((scope) => resolveManagedVariablesInString(scope, variables)) }
      : {}),
  };
}

function collectOptional(value: string | undefined, out: Set<string>): void {
  if (value === undefined) return;
  for (const name of managedVariableNamesInString(value)) out.add(name);
}

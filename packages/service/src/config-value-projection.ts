import type { ConfigValueMetadata, ManagedConfigKind } from './store.js';

type ConfigSource =
  | { readonly kind: 'organization'; readonly organizationId: string }
  | { readonly kind: 'app'; readonly organizationId: string; readonly appId: string }
  | {
      readonly kind: 'environment';
      readonly organizationId: string;
      readonly appId: string;
      readonly environmentId: string;
      readonly environmentName: string;
      readonly isProduction: boolean;
    };

export interface EffectiveConfigRow {
  readonly name: string;
  readonly source: ConfigSource;
  readonly fallbackSource?: ConfigSource;
  readonly value?: string;
}

export interface EffectiveConfigResponse {
  readonly kind: 'secret' | 'variable';
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly isProduction: boolean;
  };
  readonly capabilities: { readonly canManage: boolean; readonly canReveal: boolean };
  readonly entries: readonly EffectiveConfigRow[];
}

export interface EffectiveConfigProjectionInput {
  readonly kind: ManagedConfigKind;
  readonly organization: { readonly id: string };
  readonly app: { readonly id: string };
  readonly environment: {
    readonly id: string;
    readonly name: string;
    readonly isProduction: boolean;
  };
  readonly organizationValues: readonly ConfigValueMetadata[];
  readonly appValues: readonly ConfigValueMetadata[];
  readonly environmentValues: readonly ConfigValueMetadata[];
}

/**
 * Builds the effective org → app → environment view without exposing secret values. Each override retains
 * exactly its nearest lower-precedence source so clients can explain inheritance without resolving values.
 */
export function projectEffectiveConfig(
  input: EffectiveConfigProjectionInput,
): readonly EffectiveConfigRow[] {
  const projected = new Map<string, EffectiveConfigRow>();
  const organizationSource: ConfigSource = {
    kind: 'organization',
    organizationId: input.organization.id,
  };
  const appSource: ConfigSource = {
    kind: 'app',
    organizationId: input.organization.id,
    appId: input.app.id,
  };
  const environmentSource: ConfigSource = {
    kind: 'environment',
    organizationId: input.organization.id,
    appId: input.app.id,
    environmentId: input.environment.id,
    environmentName: input.environment.name,
    isProduction: input.environment.isProduction,
  };

  projectScope(projected, input.kind, input.organizationValues, organizationSource);
  projectScope(projected, input.kind, input.appValues, appSource);
  projectScope(projected, input.kind, input.environmentValues, environmentSource);
  return [...projected.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function projectScope(
  projected: Map<string, EffectiveConfigRow>,
  kind: ManagedConfigKind,
  values: readonly ConfigValueMetadata[],
  source: ConfigSource,
): void {
  for (const value of values) {
    const inherited = projected.get(value.name);
    projected.set(value.name, {
      name: value.name,
      source,
      ...(inherited !== undefined ? { fallbackSource: inherited.source } : {}),
      ...(kind === 'variable' && value.value !== undefined ? { value: value.value } : {}),
    });
  }
}

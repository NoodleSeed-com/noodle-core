import { validateConfigName, validateConfigScope } from './validate.js';

export type ManagedConfigKind = 'secret' | 'variable';

export type ConfigScope =
  | { readonly level: 'org'; readonly org: string }
  | { readonly level: 'app'; readonly org: string; readonly app: string }
  | { readonly level: 'env'; readonly org: string; readonly app: string; readonly env: string };

export interface ConfigValueMetadata {
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
  readonly value?: string;
}

export interface ConfigStore {
  setConfigValue(input: {
    readonly kind: ManagedConfigKind;
    readonly scope: ConfigScope;
    readonly name: string;
    readonly value: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  }): Promise<ConfigValueMetadata>;
  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean>;
  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]>;
  resolveConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
    name?: string,
  ): Promise<Record<string, string>>;
}

export class InMemoryConfigStore implements ConfigStore {
  readonly #records = new Map<string, ConfigRecord>();

  setConfigValue(input: {
    readonly kind: ManagedConfigKind;
    readonly scope: ConfigScope;
    readonly name: string;
    readonly value: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  }): Promise<ConfigValueMetadata> {
    const scope = validateConfigScope(input.scope);
    const name = validateConfigName(input.name);
    const record: ConfigRecord = {
      kind: input.kind,
      scope,
      name,
      value: input.value,
      updatedAt: new Date().toISOString(),
      ...(input.updatedBySubject !== undefined ? { updatedBySubject: input.updatedBySubject } : {}),
      ...(input.updatedByEmail !== undefined ? { updatedByEmail: input.updatedByEmail } : {}),
    };
    this.#records.set(configKey(input.kind, scope, name), record);
    return Promise.resolve(toMetadata(record));
  }

  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean> {
    return Promise.resolve(
      this.#records.delete(configKey(kind, validateConfigScope(scope), validateConfigName(name))),
    );
  }

  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]> {
    const safe = validateConfigScope(scope);
    return Promise.resolve(
      [...this.#records.values()]
        .filter((record) => record.kind === kind && sameScope(record.scope, safe))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(toMetadata),
    );
  }

  resolveConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
    name?: string,
  ): Promise<Record<string, string>> {
    const safeName = name === undefined ? undefined : validateConfigName(name);
    const chain = scopeChain(validateConfigScope(scope));
    if (safeName !== undefined) {
      for (let index = chain.length - 1; index >= 0; index -= 1) {
        const current = chain[index] as ConfigScope;
        const record = [...this.#records.values()].find(
          (candidate) =>
            candidate.kind === kind &&
            candidate.name === safeName &&
            sameScope(candidate.scope, current),
        );
        if (record !== undefined) return Promise.resolve({ [safeName]: record.value });
      }
      return Promise.resolve({});
    }
    const out: Record<string, string> = {};
    for (const current of chain) {
      for (const record of this.#records.values()) {
        if (record.kind === kind && sameScope(record.scope, current))
          out[record.name] = record.value;
      }
    }
    return Promise.resolve(out);
  }
}

export function resolveConfigScope(input: {
  readonly org: string;
  readonly app?: string;
  readonly env?: string;
}): ConfigScope {
  if (input.env !== undefined) {
    if (input.app === undefined) throw new Error('environment config scope requires app');
    return validateConfigScope({ level: 'env', org: input.org, app: input.app, env: input.env });
  }
  if (input.app !== undefined)
    return validateConfigScope({ level: 'app', org: input.org, app: input.app });
  return validateConfigScope({ level: 'org', org: input.org });
}

export function scopeChain(scope: ConfigScope): readonly ConfigScope[] {
  if (scope.level === 'org') return [scope];
  if (scope.level === 'app') return [{ level: 'org', org: scope.org }, scope];
  return [
    { level: 'org', org: scope.org },
    { level: 'app', org: scope.org, app: scope.app },
    scope,
  ];
}

interface ConfigRecord {
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
}

function configKey(kind: ManagedConfigKind, scope: ConfigScope, name: string): string {
  return `${kind}/${scopePath(scope)}/${name}`;
}

function scopePath(scope: ConfigScope): string {
  if (scope.level === 'org') return `org/${scope.org}`;
  if (scope.level === 'app') return `org/${scope.org}/app/${scope.app}`;
  return `org/${scope.org}/app/${scope.app}/env/${scope.env}`;
}

function sameScope(a: ConfigScope, b: ConfigScope): boolean {
  return scopePath(a) === scopePath(b);
}

function toMetadata(record: ConfigRecord): ConfigValueMetadata {
  return {
    kind: record.kind,
    scope: record.scope,
    name: record.name,
    updatedAt: record.updatedAt,
    ...(record.updatedBySubject !== undefined ? { updatedBySubject: record.updatedBySubject } : {}),
    ...(record.updatedByEmail !== undefined ? { updatedByEmail: record.updatedByEmail } : {}),
    ...(record.kind === 'variable' ? { value: record.value } : {}),
  };
}

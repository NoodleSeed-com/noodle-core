import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { validateConfigName, validateConfigScope } from './validate.js';

export type ManagedConfigKind = 'secret' | 'variable';

export type ConfigScope =
  | { readonly level: 'org'; readonly org: string }
  | { readonly level: 'app'; readonly org: string; readonly app: string }
  | { readonly level: 'env'; readonly org: string; readonly app: string; readonly env: string };

export interface ConfigValueMetadata {
  /** Internal mutation identity; non-enumerable and excluded from operator wire projections. */
  readonly generation?: string;
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name: string;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
  readonly value?: string;
  readonly valueOrigin?: 'default';
}

export interface ConfigValueInput {
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name: string;
  readonly value: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
  readonly valueOrigin?: 'default';
}

export interface ConfigStore {
  setConfigValue(input: ConfigValueInput): Promise<ConfigValueMetadata>;
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
  /** Atomic organization-scoped snapshot. Required for hosted business-setting mutations. */
  transactConfig?<T>(org: string, work: (transaction: ConfigStore) => Promise<T>): Promise<T>;
}

const memoryTransactions = new AsyncLocalStorage<{
  owner: ConfigStore;
  snapshot: MemoryConfigSnapshot;
  org: string;
  active: boolean;
  failure?: { error: unknown } | undefined;
}>();

class MemoryConfigSnapshot implements ConfigStore {
  #records = new Map<string, ConfigRecord>();
  get records(): Map<string, ConfigRecord> {
    const context = memoryTransactions.getStore();
    return context?.active && context.owner === this ? context.snapshot.records : this.#records;
  }
  set records(value: Map<string, ConfigRecord>) {
    this.#records = value;
  }

  setConfigValue(input: ConfigValueInput): Promise<ConfigValueMetadata> {
    const scope = validateConfigScope(input.scope);
    const name = validateConfigName(input.name);
    const record: ConfigRecord = {
      kind: input.kind,
      scope,
      name,
      value: input.value,
      updatedAt: new Date().toISOString(),
      generation: randomUUID(),
      ...(input.updatedBySubject !== undefined ? { updatedBySubject: input.updatedBySubject } : {}),
      ...(input.updatedByEmail !== undefined ? { updatedByEmail: input.updatedByEmail } : {}),
      ...(input.valueOrigin === undefined ? {} : { valueOrigin: input.valueOrigin }),
    };
    this.records.set(configKey(input.kind, scope, name), record);
    return Promise.resolve(toMetadata(record));
  }

  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean> {
    return Promise.resolve(
      this.records.delete(configKey(kind, validateConfigScope(scope), validateConfigName(name))),
    );
  }

  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]> {
    const safe = validateConfigScope(scope);
    return Promise.resolve(
      [...this.records.values()]
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
    const rows = scopeChain(validateConfigScope(scope)).flatMap((current) =>
      [...this.records.values()].filter(
        (record) =>
          record.kind === kind &&
          sameScope(record.scope, current) &&
          (safeName === undefined || record.name === safeName),
      ),
    );
    return Promise.resolve(effectiveConfigValues(rows));
  }
}

/** Copy-on-commit isolates readers from partially applied batches; transactions serialize writers. */
export class InMemoryConfigStore extends MemoryConfigSnapshot {
  #pending: Promise<void> = Promise.resolve();

  override setConfigValue(input: ConfigValueInput): Promise<ConfigValueMetadata> {
    return this.transactConfig(input.scope.org, (transaction) => transaction.setConfigValue(input));
  }

  override deleteConfigValue(
    kind: ManagedConfigKind,
    scope: ConfigScope,
    name: string,
  ): Promise<boolean> {
    return this.transactConfig(scope.org, (transaction) =>
      transaction.deleteConfigValue(kind, scope, name),
    );
  }

  async transactConfig<T>(org: string, work: (transaction: ConfigStore) => Promise<T>): Promise<T> {
    validateConfigScope({ level: 'org', org });
    const active = memoryTransactions.getStore();
    if (active?.active && active.owner === this) {
      try {
        if (active.org !== org) throw new Error('configuration transaction organization mismatch');
        return await work(scopeConfigTransaction(org, active.snapshot));
      } catch (error) {
        active.failure ??= { error };
        throw error;
      }
    }
    const previous = this.#pending;
    let release = () => {};
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = new MemoryConfigSnapshot();
    snapshot.records = new Map(this.records);
    const context = {
      owner: this,
      snapshot,
      org,
      active: true,
      failure: undefined as { error: unknown } | undefined,
    };
    try {
      const result = await memoryTransactions.run(context, () =>
        work(scopeConfigTransaction(org, snapshot)),
      );
      if (context.failure) throw context.failure.error;
      this.records = snapshot.records;
      return result;
    } finally {
      context.active = false;
      release();
    }
  }
}

/** Prevent a transaction from reaching an organization outside its acquired lock. */
export function scopeConfigTransaction(org: string, transaction: ConfigStore): ConfigStore {
  const check = (scope: ConfigScope) => {
    if (scope.org !== org) throw new Error('configuration transaction organization mismatch');
  };
  return {
    setConfigValue(input) {
      check(input.scope);
      return transaction.setConfigValue(input);
    },
    deleteConfigValue(kind, scope, name) {
      check(scope);
      return transaction.deleteConfigValue(kind, scope, name);
    },
    listConfigValues(kind, scope) {
      check(scope);
      return transaction.listConfigValues(kind, scope);
    },
    resolveConfigValues(kind, scope, name) {
      check(scope);
      return transaction.resolveConfigValues(kind, scope, name);
    },
  };
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
  readonly generation: string;
  readonly kind: ManagedConfigKind;
  readonly scope: ConfigScope;
  readonly name: string;
  readonly value: string;
  readonly updatedAt: string;
  readonly updatedBySubject?: string;
  readonly updatedByEmail?: string;
  readonly valueOrigin?: 'default';
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
  return Object.defineProperty(
    {
      kind: record.kind,
      scope: record.scope,
      name: record.name,
      updatedAt: record.updatedAt,
      ...(record.updatedBySubject !== undefined
        ? { updatedBySubject: record.updatedBySubject }
        : {}),
      ...(record.updatedByEmail !== undefined ? { updatedByEmail: record.updatedByEmail } : {}),
      ...(record.kind === 'variable' ? { value: record.value } : {}),
      ...(record.valueOrigin === undefined ? {} : { valueOrigin: record.valueOrigin }),
    },
    'generation',
    { value: record.generation },
  );
}

/** Explicit operator values outrank pinned publisher defaults at every hierarchy level. */
export function effectiveConfigValues(
  rows: readonly Pick<ConfigValueMetadata, 'name' | 'value' | 'valueOrigin'>[],
): Record<string, string> {
  const defaults: Record<string, string> = {};
  const explicit: Record<string, string> = {};
  for (const row of rows) {
    if (row.value === undefined) continue;
    if (row.valueOrigin === 'default')
      Object.defineProperty(defaults, row.name, {
        value: row.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else
      Object.defineProperty(explicit, row.name, {
        value: row.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
  }
  return { ...defaults, ...explicit };
}

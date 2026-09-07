import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ConfigScope,
  ConfigStore,
  ConfigValueMetadata,
  ManagedConfigKind,
} from '@noodle-borg/service/local';
import { readProjectDotenv } from './project-dotenv.js';

export type LocalConfigKind = 'secret' | 'variable';
export type LocalConfigScope =
  | { readonly level: 'org'; readonly org: string }
  | { readonly level: 'app'; readonly org: string; readonly app: string }
  | { readonly level: 'env'; readonly org: string; readonly app: string; readonly env: string };

export interface LocalConfigRecord {
  readonly kind: LocalConfigKind;
  readonly scope: LocalConfigScope;
  readonly name: string;
  readonly value?: string;
}

export interface LocalTenantRef {
  readonly org: string;
  readonly app: string;
  readonly env: string;
}

const FILE = '.env.noodle';
const NAME = /^[A-Za-z0-9_]+$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function localConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, FILE);
}

export function setLocalConfigValue(
  cwd: string,
  input: {
    readonly kind: LocalConfigKind;
    readonly scope: LocalConfigScope;
    readonly name: string;
    readonly value: string;
  },
): void {
  const safe = {
    ...input,
    scope: validateScope(input.scope),
    name: validateName(input.name),
    value: validateLocalConfigValue(input.value),
  };
  const records = parseLocalConfig(cwd).filter(
    (record) =>
      !(
        record.kind === safe.kind &&
        sameScope(record.scope, safe.scope) &&
        record.name === safe.name
      ),
  );
  records.push(safe);
  writeLocalConfig(cwd, records);
}

export function deleteLocalConfigValue(
  cwd: string,
  kind: LocalConfigKind,
  scope: LocalConfigScope,
  name: string,
): boolean {
  const safeScope = validateScope(scope);
  const safeName = validateName(name);
  const records = parseLocalConfig(cwd);
  const next = records.filter(
    (record) =>
      !(record.kind === kind && sameScope(record.scope, safeScope) && record.name === safeName),
  );
  if (next.length === records.length) return false;
  writeLocalConfig(cwd, next);
  return true;
}

export function readLocalConfigValues(
  cwd: string,
  kind: LocalConfigKind,
  scope: LocalConfigScope,
): readonly LocalConfigRecord[] {
  const safeScope = validateScope(scope);
  return parseLocalConfig(cwd)
    .filter((record) => record.kind === kind && sameScope(record.scope, safeScope))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((record) => toPublicRecord(record));
}

export function resolveLocalConfigValues(
  cwd: string,
  kind: LocalConfigKind,
  ref: LocalTenantRef,
): Record<string, string> {
  const scope = validateScope({ level: 'env', org: ref.org, app: ref.app, env: ref.env });
  const out: Record<string, string> = {};
  for (const current of scopeChain(scope)) {
    for (const record of parseLocalConfig(cwd)) {
      if (record.kind === kind && sameScope(record.scope, current)) out[record.name] = record.value;
    }
  }
  return out;
}

/** Local dev resolves ordinary `.env` values as a read-only fallback beneath scoped `.env.noodle`. */
export function createLocalDevConfigStore(cwd: string = process.cwd()): ConfigStore {
  return new DotenvFallbackConfigStore(cwd, new LocalFileConfigStore(cwd));
}

class DotenvFallbackConfigStore implements ConfigStore {
  readonly #cwd: string;
  readonly #managed: ConfigStore;

  constructor(cwd: string, managed: ConfigStore) {
    this.#cwd = cwd;
    this.#managed = managed;
  }

  setConfigValue(input: {
    readonly kind: ManagedConfigKind;
    readonly scope: ConfigScope;
    readonly name: string;
    readonly value: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  }): Promise<ConfigValueMetadata> {
    return this.#managed.setConfigValue(input);
  }

  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean> {
    return this.#managed.deleteConfigValue(kind, scope, name);
  }

  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]> {
    return this.#managed.listConfigValues(kind, scope);
  }

  async resolveConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
    name?: string,
  ): Promise<Record<string, string>> {
    const fallback = readProjectDotenv(this.#cwd)?.values ?? {};
    const managed = await this.#managed.resolveConfigValues(kind, scope, name);
    const resolved = { ...fallback, ...managed };
    if (name === undefined) return resolved;
    return resolved[name] === undefined ? {} : { [name]: resolved[name] };
  }
}

class LocalFileConfigStore implements ConfigStore {
  readonly #cwd: string;

  constructor(cwd: string) {
    this.#cwd = cwd;
  }

  setConfigValue(input: {
    readonly kind: ManagedConfigKind;
    readonly scope: ConfigScope;
    readonly name: string;
    readonly value: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  }): Promise<ConfigValueMetadata> {
    setLocalConfigValue(this.#cwd, input);
    return Promise.resolve({
      kind: input.kind,
      scope: input.scope,
      name: input.name,
      updatedAt: new Date().toISOString(),
      ...(input.kind === 'variable' ? { value: input.value } : {}),
      ...(input.updatedBySubject !== undefined ? { updatedBySubject: input.updatedBySubject } : {}),
      ...(input.updatedByEmail !== undefined ? { updatedByEmail: input.updatedByEmail } : {}),
    });
  }

  deleteConfigValue(kind: ManagedConfigKind, scope: ConfigScope, name: string): Promise<boolean> {
    return Promise.resolve(deleteLocalConfigValue(this.#cwd, kind, scope, name));
  }

  listConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<readonly ConfigValueMetadata[]> {
    return Promise.resolve(
      readLocalConfigValues(this.#cwd, kind, scope).map((record) => ({
        kind: record.kind,
        scope: record.scope,
        name: record.name,
        updatedAt: new Date().toISOString(),
        ...(record.kind === 'variable' && record.value !== undefined
          ? { value: record.value }
          : {}),
      })),
    );
  }

  resolveConfigValues(
    kind: ManagedConfigKind,
    scope: ConfigScope,
  ): Promise<Record<string, string>> {
    const envScope =
      scope.level === 'env'
        ? scope
        : scope.level === 'app'
          ? { level: 'env' as const, org: scope.org, app: scope.app, env: 'dev' }
          : { level: 'env' as const, org: scope.org, app: 'app', env: 'dev' };
    return Promise.resolve(resolveLocalConfigValues(this.#cwd, kind, envScope));
  }
}

function parseLocalConfig(cwd: string): readonly Required<LocalConfigRecord>[] {
  const path = localConfigPath(cwd);
  if (!existsSync(path)) return [];
  const records: Required<LocalConfigRecord>[] = [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(secret|var)\s+(\S+)\s+([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (!match) throw invalidLocalConfigSyntax(index + 1);
    let scope: LocalConfigScope;
    let name: string;
    try {
      scope = parseScope(match[2] as string);
      name = validateName(match[3] as string);
    } catch {
      throw invalidLocalConfigSyntax(index + 1);
    }
    records.push({
      kind: match[1] === 'secret' ? 'secret' : 'variable',
      scope,
      name,
      value: match[4] as string,
    });
  }
  return records;
}

function invalidLocalConfigSyntax(lineNumber: number): Error {
  return new Error(`invalid .env.noodle syntax at line ${lineNumber} (value redacted)`);
}

function validateLocalConfigValue(value: string): string {
  if (/[\r\n]/u.test(value)) {
    throw new Error('local managed values must be a single line');
  }
  return value;
}

function writeLocalConfig(cwd: string, records: readonly Required<LocalConfigRecord>[]): void {
  const body = [...records]
    .sort((a, b) =>
      `${scopePath(a.scope)}/${a.kind}/${a.name}`.localeCompare(
        `${scopePath(b.scope)}/${b.kind}/${b.name}`,
      ),
    )
    .map(
      (record) =>
        `${record.kind === 'secret' ? 'secret' : 'var'} ${scopePath(record.scope)} ` +
        `${record.name}=${record.value}`,
    )
    .join('\n');
  const path = localConfigPath(cwd);
  writeFileSync(path, body.length > 0 ? `${body}\n` : '', { mode: 0o600 });
  chmodSync(path, 0o600);
}

function toPublicRecord(record: Required<LocalConfigRecord>): LocalConfigRecord {
  return {
    kind: record.kind,
    scope: record.scope,
    name: record.name,
    ...(record.kind === 'variable' ? { value: record.value } : {}),
  };
}

function parseScope(raw: string): LocalConfigScope {
  const parts = raw.split('/');
  if (parts.length === 2 && parts[0] === 'org') {
    return validateScope({ level: 'org', org: parts[1] as string });
  }
  if (parts.length === 4 && parts[0] === 'org' && parts[2] === 'app') {
    return validateScope({ level: 'app', org: parts[1] as string, app: parts[3] as string });
  }
  if (parts.length === 6 && parts[0] === 'org' && parts[2] === 'app' && parts[4] === 'env') {
    return validateScope({
      level: 'env',
      org: parts[1] as string,
      app: parts[3] as string,
      env: parts[5] as string,
    });
  }
  throw new Error(`invalid config scope "${raw}"`);
}

function validateScope(scope: LocalConfigScope): LocalConfigScope {
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

function validateSlug(kind: string, value: string): string {
  if (!SLUG.test(value)) throw new Error(`invalid ${kind} slug "${value}"`);
  return value;
}

function validateName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid config name "${name}"`);
  return name;
}

function scopeChain(scope: LocalConfigScope): readonly LocalConfigScope[] {
  if (scope.level === 'org') return [scope];
  if (scope.level === 'app') return [{ level: 'org', org: scope.org }, scope];
  return [
    { level: 'org', org: scope.org },
    { level: 'app', org: scope.org, app: scope.app },
    scope,
  ];
}

function scopePath(scope: LocalConfigScope): string {
  if (scope.level === 'org') return `org/${scope.org}`;
  if (scope.level === 'app') return `org/${scope.org}/app/${scope.app}`;
  return `org/${scope.org}/app/${scope.app}/env/${scope.env}`;
}

function sameScope(a: LocalConfigScope, b: LocalConfigScope): boolean {
  return scopePath(a) === scopePath(b);
}

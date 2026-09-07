/**
 * `noodle secrets` / `noodle variables` — managed config value commands and their
 * parse/print/scope helpers.
 */
import { readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import {
  CONFIG_NAME_PATTERN,
  type ConfigScope,
  type ManagedConfigKind,
} from '@noodle-borg/service/local';
import { getAuthMetadata } from '../auth-discovery.js';
import { presentUrl, type UrlOpener } from '../browser.js';
import type { ConfigLocation } from '../config.js';
import { type NoodleConfig, readConfig } from '../config.js';
import {
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
  serviceJson,
} from '../control-plane.js';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { AMBER } from '../gradient.js';
import {
  deleteLocalConfigValue,
  readLocalConfigValues,
  resolveLocalConfigValues,
  setLocalConfigValue,
} from '../local-config.js';
import { resolveEffectiveLocalTarget } from '../local-target.js';
import { isInteractive } from '../prompts.js';
import { relativeTime } from '../relative-time.js';
import { type Column, renderTable, type TableOptions } from '../table.js';
import { findDeployProjectRoot } from './deploy-target.js';
import { runInstallationVariables } from './installation-variables.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import { DIM_GRAY, stdoutTableOptions } from './resource-shared.js';
import { missingLogin, parseCommandFlags, printCliFailure, usage } from './shared.js';

export async function runConfigValues(
  kind: ManagedConfigKind,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  options: ConfigValuesOptions = {},
): Promise<number> {
  const [action, maybeName, ...remaining] = rest;
  const name = maybeName !== undefined && !maybeName.startsWith('--') ? maybeName : undefined;
  const tail = name !== undefined ? remaining : rest.slice(1);
  const args = parseConfigArgs(tail);
  const config = readConfig(home);
  const ambiguousTarget = ambiguousRuntimeFailure(kind, args);
  if (ambiguousTarget !== undefined) return ambiguousTarget;
  const runtime = args.runtime ?? config.defaultRuntime ?? 'local';
  if (tail.includes('--installation') || tail.includes('--expected-revision')) {
    return runInstallationVariables({
      kind,
      action,
      name,
      args,
      runtime,
      org: args.org ?? config.defaultOrg,
      env,
      home,
      readValue: () => configInputValue(args, env),
    });
  }
  const localProjectRoot = findDeployProjectRoot() ?? process.cwd();
  const localTargetResolution =
    runtime === 'local'
      ? resolveEffectiveLocalTarget({
          cwd: localProjectRoot,
          ...(args.org !== undefined ? { org: args.org } : {}),
          ...(args.app !== undefined ? { app: args.app } : {}),
          ...(args.targetEnv !== undefined ? { env: args.targetEnv } : {}),
          home,
        })
      : undefined;
  const targetConfig =
    localTargetResolution === undefined
      ? config
      : {
          defaultOrg: localTargetResolution.target.org,
          defaultApp: localTargetResolution.target.app,
          defaultEnv: localTargetResolution.target.env,
        };
  const scope = configScope(args.scope ?? 'env', args, targetConfig);
  if (scope === undefined) {
    if (args.json) {
      return printCliFailure(
        configCommand(kind),
        {
          code: 'target_required',
          message: 'The selected config scope is missing required target fields.',
          cause: '--org, --app, and --env are required for the chosen scope.',
          fix: 'Set a target once or pass the scope identifiers explicitly.',
          next: 'noodle target set --org <org> --app <app> --env <env>',
          exitCode: EXIT.USAGE,
        },
        true,
      );
    }
    printRecovery({
      command: configCommand(kind),
      cause: '--org, --app, and --env are required for the chosen scope.',
      fix: 'Set a target once or pass the scope identifiers explicitly.',
      next: 'noodle target set --org <org> --app <app> --env <env>',
    });
    return 2;
  }
  const command = configCommand(kind);
  if (kind === 'secret' && action === 'reveal') {
    return revealSecretInConsole({
      ...(name !== undefined ? { name } : {}),
      args,
      runtime,
      scope,
      env,
      home,
      interactive: options.interactive ?? isInteractive,
      ...(options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
    });
  }
  try {
    if (runtime === 'local') {
      if (!args.json) printConfigTarget({ runtime, scope });
      if (action === 'set' && name !== undefined) {
        setLocalConfigValue(localProjectRoot, {
          kind,
          scope,
          name,
          value: await configInputValue(args, env, secretInputOptions(kind, name)),
        });
        if (args.json) printJsonOk({ runtime, scope, name });
        else console.log(`set ${name}`);
        return 0;
      }
      if (action === 'list') {
        const records = readLocalConfigValues(localProjectRoot, kind, scope);
        if (args.json) printJsonOk({ runtime, scope, values: safeConfigRecords(kind, records) });
        else if (records.length > 0) {
          console.log(
            renderConfigValuesTable(
              records.map((record) => ({ name: record.name, scope: scope.level })),
              stdoutTableOptions(),
            ),
          );
        } else console.log(`No ${kind}s set at this scope.`);
        return 0;
      }
      if (action === 'delete' && name !== undefined) {
        const deleted = deleteLocalConfigValue(localProjectRoot, kind, scope, name);
        if (args.json) printJsonOk({ runtime, scope, name, deleted });
        else console.log(deleted ? `deleted ${name}` : `${name} was not set`);
        return 0;
      }
      if (action === 'resolve') {
        const values = resolveLocalConfigValues(
          localProjectRoot,
          kind,
          tenantForScope(scope, targetConfig),
        );
        if (args.json)
          printJsonOk({ runtime, scope, values: safeResolvedConfig(kind, values, name) });
        else printResolvedConfig(kind, values, name);
        return 0;
      }
    } else {
      const { serviceUrl, token } = await resolveControlPlaneToken({
        serviceFlag: args.service,
        authFlag: args.authToken,
        env,
        home,
      });
      if (token === undefined) return missingLogin(command, args.json);
      if (!args.json) printConfigTarget({ runtime, scope, serviceUrl });
      const base = `${serviceUrl}${configApiPath(kind, scope)}`;
      if (action === 'set' && name !== undefined) {
        await serviceJson(`${base}/${encodeURIComponent(name)}`, token, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            value: await configInputValue(args, env, secretInputOptions(kind, name)),
          }),
        });
        if (args.json) printJsonOk({ runtime, service: serviceUrl, scope, name });
        else console.log(`set ${name}`);
        return 0;
      }
      if (action === 'list' || action === 'resolve') {
        const body = await serviceJson<{
          ok: true;
          values: readonly {
            name: string;
            value?: string;
            updatedAt: string;
            updatedByEmail?: string;
          }[];
        }>(base, token);
        if (args.json)
          printJsonOk({
            runtime,
            service: serviceUrl,
            scope,
            values: safeConfigRecords(kind, body.values),
          });
        else if (body.values.length > 0) {
          console.log(
            renderConfigValuesTable(
              body.values.map((value) => ({
                name: value.name,
                scope: scope.level,
                updatedAt: value.updatedAt,
                ...(value.updatedByEmail !== undefined ? { updatedBy: value.updatedByEmail } : {}),
              })),
              stdoutTableOptions(),
            ),
          );
        } else console.log(`No ${kind}s set at this scope.`);
        return 0;
      }
      if (action === 'delete' && name !== undefined) {
        await serviceJson(`${base}/${encodeURIComponent(name)}`, token, { method: 'DELETE' });
        if (args.json) printJsonOk({ runtime, service: serviceUrl, scope, name, deleted: true });
        else console.log(`deleted ${name}`);
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) throw error;
    if (args.json) {
      return printCliFailure(
        command,
        {
          code: 'command_failed',
          message: errorMessage(error),
          cause: errorMessage(error),
          fix: 'Check the target scope, login, service URL, and value source.',
          next: `${command} list --scope ${scope.level}`,
          exitCode: EXIT.FAILURE,
        },
        true,
      );
    }
    printRecovery({
      command,
      cause: errorMessage(error),
      fix: 'Check the target scope, login, service URL, and value source.',
      next: `${command} list --scope ${scope.level}`,
    });
    return 1;
  }
  if (args.json) {
    return printJsonFailure(
      {
        code: 'invalid_arguments',
        message: `${command} requires a supported action and its required name`,
        fix: `Choose a supported ${kind}s action and pass its required arguments.`,
        next: `${command} --help`,
      },
      EXIT.USAGE,
    );
  }
  usage();
  return EXIT.USAGE;
}

function printConfigTarget(input: {
  readonly runtime: 'local' | 'cloud' | 'other';
  readonly scope: ConfigScope;
  readonly serviceUrl?: string;
}): void {
  console.log(`runtime: ${input.runtime}`);
  if (input.serviceUrl !== undefined) console.log(`service: ${input.serviceUrl}`);
  console.log(`scope:   ${configScopeLabel(input.scope)}`);
}

function configScopeLabel(scope: ConfigScope): string {
  if (scope.level === 'org') return `org/${scope.org}`;
  if (scope.level === 'app') return `org/${scope.org}/app/${scope.app}`;
  return `org/${scope.org}/app/${scope.app}/env/${scope.env}`;
}

function parseConfigArgs(rest: readonly string[]): {
  readonly installation?: string;
  readonly expectedRevision?: string;
  readonly parseError?: string;
  readonly positional?: readonly string[];
  readonly runtime?: 'local' | 'cloud' | 'other';
  readonly scope?: 'org' | 'app' | 'env';
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly value?: string;
  readonly fromEnv?: string;
  readonly fromFile?: string;
  readonly fromStdin?: boolean;
  readonly service?: string;
  readonly authToken?: string;
  readonly agentOutput?: boolean;
  readonly json?: boolean;
} {
  const { runtime, scope, fromStdin, agentOutput, json, ...args } = parseCommandFlags(rest, {
    values: {
      '--runtime': 'runtime',
      '--scope': 'scope',
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--value': 'value',
      '--from-env': 'fromEnv',
      '--from-file': 'fromFile',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--installation': 'installation',
      '--expected-revision': 'expectedRevision',
    },
    booleans: {
      '--from-stdin': 'fromStdin',
      '--agent-output': 'agentOutput',
      '--fix-prompt': 'agentOutput',
      '--json': 'json',
    },
  });
  return {
    ...args,
    ...(runtime === 'local' || runtime === 'cloud' || runtime === 'other' ? { runtime } : {}),
    ...(scope === 'org' || scope === 'app' || scope === 'env' ? { scope } : {}),
    ...(fromStdin ? { fromStdin } : {}),
    ...(agentOutput ? { agentOutput } : {}),
    ...(json ? { json } : {}),
  };
}

/**
 * A command that spells out a complete hosted target (`--org` **and** `--app` **and** `--env`) looks
 * remote, so it must not fall through to the implicit local default and silently write `.env.noodle`
 * while reporting success (#701). The check keys on the flags actually passed, not on the saved
 * `defaultRuntime`, so a fully-qualified command can never resolve implicitly in either direction.
 *
 * Everything else is untouched: an explicit `--runtime` always wins — including `--runtime local`
 * with coordinates, which is a real local scope (`resolveEffectiveLocalTarget`) — and an unqualified
 * command still follows explicit fields, then complete project link, then unlinked project app/name plus
 * local defaults.
 */
function ambiguousRuntimeFailure(
  kind: ManagedConfigKind,
  args: ReturnType<typeof parseConfigArgs>,
): number | undefined {
  if (args.runtime !== undefined) return undefined;
  if (args.org === undefined || args.app === undefined || args.targetEnv === undefined) {
    return undefined;
  }
  const command = configCommand(kind);
  const cause =
    '--org, --app, and --env name a complete hosted target, but --runtime was not given.';
  const fix =
    'Pass --runtime cloud to configure the hosted environment, or --runtime local for this machine.';
  const next = `noodle ${command} set <NAME> --runtime cloud --scope env --org ${args.org} --app ${args.app} --env ${args.targetEnv}`;
  return printCliFailure(
    command,
    { code: 'runtime_required', message: cause, cause, fix, next, exitCode: EXIT.USAGE },
    args.json === true,
  );
}

export interface ConfigValuesOptions {
  /** Test seam; production uses the shared stdin/stdout TTY check. */
  readonly interactive?: () => boolean;
  /** Test seam; production delegates to the shared browser presenter. */
  readonly openBrowser?: UrlOpener;
}

async function revealSecretInConsole(input: {
  readonly name?: string;
  readonly args: ReturnType<typeof parseConfigArgs>;
  readonly runtime: 'local' | 'cloud' | 'other';
  readonly scope: ConfigScope;
  readonly env: NodeJS.ProcessEnv;
  readonly home: ConfigLocation;
  readonly interactive: () => boolean;
  readonly openBrowser?: UrlOpener;
}): Promise<number> {
  if (input.name === undefined || !CONFIG_NAME_PATTERN.test(input.name)) {
    if (input.args.json) {
      return printJsonFailure(
        {
          code: 'invalid_name',
          message: 'secrets reveal requires a valid secret name',
          fix: 'Pass a valid managed secret name.',
          next: 'noodle secrets list --json',
        },
        EXIT.USAGE,
      );
    }
    console.error('secrets reveal requires a valid secret name.');
    return EXIT.USAGE;
  }
  if (input.runtime !== 'cloud') {
    if (input.args.json) {
      return printJsonFailure(
        {
          code: 'invalid_runtime',
          message: 'secrets reveal is available only for the cloud runtime',
          fix: 'Pass --runtime cloud.',
          next: 'noodle secrets reveal <NAME> --runtime cloud',
        },
        EXIT.USAGE,
      );
    }
    console.error('secrets reveal is available only for the cloud runtime.');
    return EXIT.USAGE;
  }
  if (input.args.json) {
    return printJsonFailure(
      {
        code: 'unsupported_json_mode',
        message: 'secrets reveal is unavailable with --json output',
        fix: 'Use the interactive console reveal flow; secret values are never emitted as JSON.',
        next: 'noodle secrets reveal <NAME> --runtime cloud',
      },
      EXIT.USAGE,
    );
  }
  if (input.args.agentOutput) {
    console.error('secrets reveal is unavailable with agent output.');
    return EXIT.USAGE;
  }
  if (!input.interactive()) {
    console.error('secrets reveal requires an interactive terminal.');
    return EXIT.USAGE;
  }
  const scope = input.scope;
  if (scope.level !== 'env') {
    console.error('secrets reveal requires an organization, app, and environment target.');
    return EXIT.USAGE;
  }

  try {
    const { serviceUrl, token } = await resolveControlPlaneToken({
      serviceFlag: input.args.service,
      authFlag: input.args.authToken,
      env: input.env,
      home: input.home,
    });
    if (token === undefined) return missingLogin('secrets reveal');
    const { consoleUrl } = await getAuthMetadata(serviceUrl);
    if (consoleUrl === undefined) {
      throw new Error('Console Configuration is not available from this service.');
    }
    await presentUrl(consoleConfigurationUrl(consoleUrl, scope), {
      ...(input.openBrowser !== undefined ? { open: input.openBrowser } : {}),
    });
    return 0;
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) throw error;
    printRecovery({
      command: 'secrets reveal',
      cause: 'Could not open Console Configuration.',
      fix: 'Confirm the cloud target and sign in again before retrying.',
      next: 'noodle login',
    });
    return 1;
  }
}

/** Build the only CLI reveal destination; secret names are intentionally excluded. */
function consoleConfigurationUrl(
  consoleUrl: string,
  scope: Extract<ConfigScope, { readonly level: 'env' }>,
): string {
  const base = new URL(consoleUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  return (
    `${base.origin}${basePath}/apps/${encodeURIComponent(scope.org)}/${encodeURIComponent(scope.app)}` +
    `?env=${encodeURIComponent(scope.env)}&tab=configuration&kind=secrets`
  );
}

function configScope(
  level: 'org' | 'app' | 'env',
  args: { readonly org?: string; readonly app?: string; readonly targetEnv?: string },
  config: NoodleConfig,
): ConfigScope | undefined {
  const org = args.org ?? config.defaultOrg;
  const app = args.app ?? config.defaultApp;
  const targetEnv = args.targetEnv ?? config.defaultEnv ?? 'dev';
  if (level === 'org') return org !== undefined ? { level: 'org', org } : undefined;
  if (level === 'app') {
    return org !== undefined && app !== undefined ? { level: 'app', org, app } : undefined;
  }
  return org !== undefined && app !== undefined
    ? { level: 'env', org, app, env: targetEnv }
    : undefined;
}

export async function configInputValue(
  args: {
    readonly value?: string;
    readonly fromEnv?: string;
    readonly fromFile?: string;
    readonly fromStdin?: boolean;
    readonly json?: boolean;
  },
  env: NodeJS.ProcessEnv,
  options: {
    // `--value` places a secret in argv (shell history, process listings); warn and steer to safer sources.
    readonly isSecret?: boolean;
    // When no source flag is given, read the value interactively (echo disabled). The caller supplies this
    // only on a real TTY, so headless/`--json` callers still hit the "exactly one value source" contract.
    readonly promptValue?: () => Promise<string>;
    readonly warn?: (message: string) => void;
  } = {},
): Promise<string> {
  if (options.isSecret === true && args.value !== undefined && args.json !== true) {
    const warn =
      options.warn ??
      ((message: string) => {
        // cli-output-drift-allow: human-only warning for an explicit argv secret.
        process.stderr.write(`${message}\n`);
      });
    warn(
      'warning: passing a secret with --value exposes it in shell history and process listings; prefer --from-stdin, --from-env, or the interactive prompt.',
    );
  }
  const sources = [
    args.value,
    args.fromEnv,
    args.fromFile,
    args.fromStdin ? 'stdin' : undefined,
  ].filter((value) => value !== undefined);
  if (sources.length === 0 && options.promptValue !== undefined) return options.promptValue();
  if (sources.length !== 1) throw new Error('exactly one value source is required');
  if (args.value !== undefined) return args.value;
  if (args.fromEnv !== undefined) {
    const value = env[args.fromEnv];
    if (value === undefined) throw new Error(`environment variable ${args.fromEnv} is not set`);
    return value;
  }
  if (args.fromFile !== undefined) {
    if (!statSync(args.fromFile).isFile()) {
      throw new Error('--from-file must reference a regular file');
    }
    return readFileSync(args.fromFile, 'utf8').replace(/\r?\n$/, '');
  }
  return readStdin();
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

/**
 * Read a single line from the TTY with echo disabled, so a typed secret never lands on screen or in a
 * scrollback buffer. Only invoked when stdin/stdout are interactive (see {@link secretInputOptions}).
 */
async function promptHiddenValue(label: string): Promise<string> {
  return new Promise<string>((resolve) => {
    let muted = false;
    const muteStream = new Writable({
      write(chunk, encoding, callback): void {
        // cli-output-drift-allow: human-only interactive hidden-value prompt.
        if (!muted) process.stdout.write(chunk as Buffer, encoding as BufferEncoding);
        callback();
      },
    });
    const rl = createInterface({ input: process.stdin, output: muteStream, terminal: true });
    // cli-output-drift-allow: human-only interactive hidden-value prompt.
    process.stdout.write(`${label}: `);
    muted = true;
    rl.question('', (answer) => {
      muted = false;
      // cli-output-drift-allow: human-only interactive hidden-value prompt.
      process.stdout.write('\n');
      rl.close();
      resolve(answer.replace(/\r?\n$/, ''));
    });
  });
}

/**
 * Value-input options for a managed config `set`. Secrets get the `--value` exposure warning and, on a real
 * TTY with no source flag, an echo-disabled prompt. Variables (non-secret) get neither. Headless/`--json`
 * callers never receive a `promptValue`, so they keep the flag-driven "exactly one value source" contract.
 */
export function secretInputOptions(
  kind: ManagedConfigKind,
  name: string,
): { readonly isSecret: boolean; readonly promptValue?: () => Promise<string> } {
  const isSecret = kind === 'secret';
  if (isSecret && isInteractive()) {
    return { isSecret, promptValue: () => promptHiddenValue(`Enter value for secret ${name}`) };
  }
  return { isSecret };
}

function configCommand(kind: ManagedConfigKind): string {
  return kind === 'secret' ? 'secrets' : 'variables';
}

function tenantForScope(
  scope: ConfigScope,
  config: NoodleConfig,
): {
  readonly org: string;
  readonly app: string;
  readonly env: string;
} {
  if (scope.level === 'env') return { org: scope.org, app: scope.app, env: scope.env };
  if (scope.level === 'app') {
    return { org: scope.org, app: scope.app, env: config.defaultEnv ?? 'dev' };
  }
  return { org: scope.org, app: config.defaultApp ?? 'app', env: config.defaultEnv ?? 'dev' };
}

function configApiPath(kind: ManagedConfigKind, scope: ConfigScope): string {
  const collection = kind === 'secret' ? 'secrets' : 'variables';
  if (scope.level === 'org') return `/v1/orgs/${encodeURIComponent(scope.org)}/${collection}`;
  if (scope.level === 'app') {
    return `/v1/orgs/${encodeURIComponent(scope.org)}/apps/${encodeURIComponent(scope.app)}/${collection}`;
  }
  return (
    `/v1/orgs/${encodeURIComponent(scope.org)}/apps/${encodeURIComponent(scope.app)}` +
    `/envs/${encodeURIComponent(scope.env)}/${collection}`
  );
}

// --- table rendering ---------------------------------------------------------------

/** One branded `secrets list` / `variables list` row (values never appear in the table). */
export interface ConfigValueRow {
  readonly name: string;
  readonly scope: 'org' | 'app' | 'env';
  readonly updatedAt?: string;
  readonly updatedBy?: string;
}

/**
 * Render the `secrets list` / `variables list` table (founder-approved design, 2026-07-06):
 * NAME / SCOPE chip (env=amber) / UPDATED relative / BY — the BY column renders only when at
 * least one row carries an updater (local `.env.noodle` records never do). Exported for tests.
 */
export function renderConfigValuesTable(
  rows: readonly ConfigValueRow[],
  opts: TableOptions,
): string {
  const columns: Column<ConfigValueRow>[] = [
    { header: 'NAME', get: (r) => r.name },
    {
      header: 'SCOPE',
      get: (r) => r.scope,
      color: (r) => (r.scope === 'env' ? AMBER : undefined),
    },
    {
      header: 'UPDATED',
      get: (r) => (r.updatedAt !== undefined ? relativeTime(r.updatedAt) : '—'),
      align: 'right',
      color: () => DIM_GRAY,
    },
  ];
  if (rows.some((r) => r.updatedBy !== undefined)) {
    columns.push({ header: 'BY', get: (r) => r.updatedBy ?? '—', color: () => DIM_GRAY });
  }
  return renderTable(columns, rows, opts);
}

function printResolvedConfig(
  kind: ManagedConfigKind,
  values: Record<string, string>,
  name: string | undefined,
): void {
  const entries = name !== undefined ? [[name, values[name]]] : Object.entries(values).sort();
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    console.log(`${key}=${kind === 'secret' ? '********' : value}`);
  }
}

function safeConfigRecords(
  kind: ManagedConfigKind,
  records: readonly {
    readonly name: string;
    readonly value?: string;
    readonly updatedAt?: string;
  }[],
): Array<{ name: string; value?: string; updatedAt?: string }> {
  return records.map((record) => ({
    name: record.name,
    ...(record.value !== undefined ? { value: kind === 'secret' ? '********' : record.value } : {}),
    ...(record.updatedAt !== undefined ? { updatedAt: record.updatedAt } : {}),
  }));
}

function safeResolvedConfig(
  kind: ManagedConfigKind,
  values: Record<string, string>,
  name: string | undefined,
): Record<string, string> {
  const entries = name !== undefined ? [[name, values[name]]] : Object.entries(values).sort();
  return Object.fromEntries(
    entries
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => [key, kind === 'secret' ? '********' : value]),
  );
}

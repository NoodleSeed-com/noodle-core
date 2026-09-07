import { readFileSync } from 'node:fs';
import type { ConfigLocation } from '../config.js';
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import { confirm } from '../prompts.js';
import { EXIT, printJsonOk } from './output.js';
import {
  authRequired,
  type CliFailure,
  printCliFailure,
  serviceFailure,
  usageError,
} from './shared.js';

const ACTIONS = [
  'create',
  'list',
  'show',
  'grant',
  'revoke-grant',
  'add-jwk',
  'create-secret',
  'revoke-credential',
  'revoke',
] as const;
type Action = (typeof ACTIONS)[number];

interface Args {
  readonly action: Action;
  readonly positionals: readonly string[];
  readonly org?: string;
  readonly app?: string;
  readonly environment?: string;
  readonly scopes: readonly string[];
  readonly label?: string;
  readonly expiresAt?: string;
  readonly file?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly yes: boolean;
}

interface ParseResult {
  readonly args?: Args;
  readonly failure?: CliFailure;
  readonly json: boolean;
}

export async function runAuthServicePrincipals(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const parsed = parseArgs(rest);
  if (parsed.failure !== undefined) {
    return printCliFailure('auth service-principals', parsed.failure, parsed.json);
  }
  const args = parsed.args as Args;
  const validation = validateArgs(args);
  if (validation !== undefined) {
    return printCliFailure('auth service-principals', validation, args.json);
  }
  if (isDestructive(args.action)) {
    const confirmation = await confirmDestructive(args);
    if (confirmation !== undefined) return confirmation;
  }

  if (args.action === 'add-jwk') {
    const jwk = readPublicJwk(args);
    if (!jwk.ok) return printCliFailure('auth service-principals', jwk.failure, args.json);
    return request(args, env, home, {
      method: 'POST',
      path: `${principalPath(args)}/credentials`,
      body: {
        kind: 'public_jwk',
        label: args.label,
        algorithm: jwk.algorithm,
        publicJwk: jwk.value,
        ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      },
    });
  }

  const operation = operationFor(args);
  return request(args, env, home, operation);
}

function parseArgs(rest: readonly string[]): ParseResult {
  const json = rest.includes('--json');
  const action = rest[0];
  if (!isAction(action)) {
    return {
      json,
      failure: usageError(
        `unknown service-principals action ${action ?? '(missing)'}`,
        'noodle auth service-principals --help',
      ),
    };
  }
  const positionals: string[] = [];
  const scopes: string[] = [];
  const values = new Map<string, string>();
  let yes = false;
  let failure: CliFailure | undefined;
  const valueFlags = new Set([
    '--org',
    '--app',
    '--env',
    '--scope',
    '--label',
    '--expires-at',
    '--file',
    '--service',
    '--auth-token',
  ]);
  for (let index = 1; index < rest.length; index++) {
    const token = rest[index];
    if (token === '--json') continue;
    if (token === '--yes') {
      yes = true;
      continue;
    }
    if (token?.startsWith('--')) {
      if (!valueFlags.has(token)) {
        failure ??= usageError(
          `unknown service-principals option ${token}`,
          `noodle auth service-principals ${action} --help`,
        );
        continue;
      }
      const value = rest[++index];
      if (value === undefined || value.startsWith('--')) {
        failure ??= usageError(
          `${token} requires a value`,
          `noodle auth service-principals ${action} --help`,
        );
        index--;
        continue;
      }
      if (token === '--scope') scopes.push(value);
      else if (values.has(token)) {
        failure ??= usageError(
          `${token} may be supplied once`,
          `noodle auth service-principals ${action} --help`,
        );
      } else values.set(token, value);
      continue;
    }
    if (token !== undefined) positionals.push(token);
  }
  const org = values.get('--org');
  const app = values.get('--app');
  const environment = values.get('--env');
  const label = values.get('--label');
  const expiresAt = values.get('--expires-at');
  const file = values.get('--file');
  const service = values.get('--service');
  const authToken = values.get('--auth-token');
  return {
    json,
    ...(failure === undefined ? {} : { failure }),
    args: {
      action,
      positionals,
      scopes,
      ...(org === undefined ? {} : { org }),
      ...(app === undefined ? {} : { app }),
      ...(environment === undefined ? {} : { environment }),
      ...(label === undefined ? {} : { label }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(file === undefined ? {} : { file }),
      ...(service === undefined ? {} : { service }),
      ...(authToken === undefined ? {} : { authToken }),
      json,
      yes,
    },
  };
}

function validateArgs(args: Args): CliFailure | undefined {
  if (args.org === undefined) return invalid(args, '--org is required');
  const positionalCounts: Readonly<Record<Action, number>> = {
    create: 1,
    list: 0,
    show: 1,
    grant: 1,
    'revoke-grant': 2,
    'add-jwk': 1,
    'create-secret': 1,
    'revoke-credential': 2,
    revoke: 1,
  };
  if (args.positionals.length !== positionalCounts[args.action]) {
    return invalid(args, `invalid positional arguments for ${args.action}`);
  }
  if (args.action === 'grant' && (args.app === undefined || args.environment === undefined)) {
    return invalid(args, 'grant requires --app and --env');
  }
  if ((args.action === 'add-jwk' || args.action === 'create-secret') && args.label === undefined) {
    return invalid(args, `${args.action} requires --label`);
  }
  if (args.action === 'add-jwk' && args.file === undefined) {
    return invalid(args, 'add-jwk requires --file');
  }
  const allowed = allowedOptions(args.action);
  for (const [name, present] of [
    ['--app', args.app !== undefined],
    ['--env', args.environment !== undefined],
    ['--scope', args.scopes.length > 0],
    ['--label', args.label !== undefined],
    ['--expires-at', args.expiresAt !== undefined],
    ['--file', args.file !== undefined],
    ['--yes', args.yes],
  ] as const) {
    if (present && !allowed.has(name))
      return invalid(args, `${name} is not valid for ${args.action}`);
  }
  if (args.expiresAt !== undefined && !isIsoTimestamp(args.expiresAt)) {
    return invalid(args, '--expires-at must be an ISO 8601 timestamp with an offset');
  }
  return undefined;
}

function operationFor(args: Args): Operation {
  if (args.action === 'create') {
    return { method: 'POST', path: collectionPath(args), body: { name: args.positionals[0] } };
  }
  if (args.action === 'list') return { method: 'GET', path: collectionPath(args) };
  if (args.action === 'show') return { method: 'GET', path: principalPath(args) };
  if (args.action === 'grant') {
    return {
      method: 'POST',
      path: `${principalPath(args)}/grants`,
      body: { app: args.app, environment: args.environment, scopes: args.scopes },
    };
  }
  if (args.action === 'create-secret') {
    return {
      method: 'POST',
      path: `${principalPath(args)}/credentials`,
      body: {
        kind: 'client_secret',
        label: args.label,
        ...(args.expiresAt === undefined ? {} : { expiresAt: args.expiresAt }),
      },
    };
  }
  if (args.action === 'revoke-grant') {
    return { method: 'DELETE', path: `${principalPath(args)}/grants/${encoded(args, 1)}` };
  }
  if (args.action === 'revoke-credential') {
    return { method: 'DELETE', path: `${principalPath(args)}/credentials/${encoded(args, 1)}` };
  }
  return { method: 'DELETE', path: principalPath(args) };
}

interface Operation {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

async function request(
  args: Args,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  operation: Operation,
): Promise<number> {
  const resolved = await resolveControlPlaneToken({
    serviceFlag: args.service,
    authFlag: args.authToken,
    env,
    home,
  });
  if (resolved.token === undefined) {
    return printCliFailure('auth service-principals', authRequired(), args.json);
  }
  try {
    const response = await serviceJson<{ readonly ok: true; readonly data?: unknown }>(
      `${resolved.serviceUrl}${operation.path}`,
      resolved.token,
      {
        method: operation.method,
        ...(operation.body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(operation.body),
            }),
      },
    );
    const data =
      args.action === 'create-secret' ? response.data : redactCredentialMaterial(response.data);
    if (args.json) printJsonOk(data ?? { status: 'revoked' });
    else printHuman(args, data);
    return EXIT.OK;
  } catch (error) {
    return printCliFailure(
      'auth service-principals',
      serviceFailure(
        'auth service-principals',
        redactRequestError(error, args.authToken),
        `noodle auth service-principals ${args.action} --help`,
      ),
      args.json,
    );
  }
}

function printHuman(args: Args, data: unknown): void {
  if (args.action === 'create-secret') {
    const record = asRecord(data);
    console.log(`client id:     ${String(record.principalId ?? args.positionals[0])}`);
    console.log(`credential id: ${String(record.credentialId ?? '')}`);
    console.log(`client secret: ${String(record.secret ?? '')}`);
    console.log('Copy this value directly into an external secrets manager now.');
    console.log('This secret cannot be retrieved later.');
    return;
  }
  if (args.action === 'list' && Array.isArray(data)) {
    if (data.length === 0) console.log('No service principals found.');
    for (const item of data) {
      const record = asRecord(item);
      console.log(
        `${String(record.principalId ?? '')}\t${String(record.status ?? '')}\t${String(record.name ?? '')}`,
      );
    }
    return;
  }
  // cli-output-drift-allow: human-only pretty view; --json uses printJsonOk above.
  if (data !== undefined) console.log(JSON.stringify(data, null, 2));
  else console.log('revoked');
}

function readPublicJwk(args: Args):
  | {
      readonly ok: true;
      readonly value: Readonly<Record<string, unknown>>;
      readonly algorithm: 'RS256' | 'ES256';
    }
  | { readonly ok: false; readonly failure: CliFailure } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(args.file as string, 'utf8'));
  } catch {
    return { ok: false, failure: invalid(args, '--file must contain one valid JSON JWK') };
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return { ok: false, failure: invalid(args, '--file must contain one JSON JWK object') };
  }
  const jwk = value as Readonly<Record<string, unknown>>;
  if (['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'].some((member) => member in jwk)) {
    return {
      ok: false,
      failure: {
        ...invalid(args, 'private JWK members are forbidden; provide a public JWK only'),
        code: 'private_jwk_forbidden',
      },
    };
  }
  if (jwk.alg !== 'RS256' && jwk.alg !== 'ES256') {
    return { ok: false, failure: invalid(args, 'the public JWK alg must be RS256 or ES256') };
  }
  return { ok: true, value: jwk, algorithm: jwk.alg };
}

async function confirmDestructive(args: Args): Promise<number | undefined> {
  if (args.yes) return undefined;
  const next = `noodle auth service-principals ${args.action} ${args.positionals.join(' ')} --org ${args.org} --yes`;
  const interactive = !args.json && process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) {
    return printCliFailure(
      'auth service-principals',
      {
        code: 'confirmation_required',
        message: `${args.action} requires confirmation`,
        cause: 'Revocation immediately disables the selected service-principal access.',
        fix: 'Re-run with --yes to confirm non-interactively.',
        next,
        exitCode: EXIT.USAGE,
      },
      args.json,
    );
  }
  const accepted = await confirm(`Confirm ${args.action} for ${args.positionals.join(' ')}?`, {
    initial: false,
  });
  if (accepted) return undefined;
  console.error('auth service-principals: cancelled');
  return EXIT.USAGE;
}

function redactCredentialMaterial(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactCredentialMaterial);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !['secret', 'secretDigest', 'publicJwk'].includes(key))
      .map(([key, nested]) => [key, redactCredentialMaterial(nested)]),
  );
}

function redactRequestError(error: unknown, token: string | undefined): unknown {
  if (
    !(error instanceof ServiceRequestError) ||
    token === undefined ||
    !error.message.includes(token)
  ) {
    return error;
  }
  return new ServiceRequestError({
    status: error.status,
    message: error.message.split(token).join('[redacted]'),
    ...(error.code === undefined ? {} : { code: error.code }),
    ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: error.retryAfterSeconds }),
  });
}

function collectionPath(args: Args): string {
  return `/v1/orgs/${encodeURIComponent(args.org as string)}/service-principals`;
}

function principalPath(args: Args): string {
  return `${collectionPath(args)}/${encoded(args, 0)}`;
}

function encoded(args: Args, index: number): string {
  return encodeURIComponent(args.positionals[index] as string);
}

function invalid(args: Pick<Args, 'action'>, message: string): CliFailure {
  return usageError(message, `noodle auth service-principals ${args.action} --help`);
}

function isAction(value: string | undefined): value is Action {
  return ACTIONS.includes(value as Action);
}

function isDestructive(action: Action): boolean {
  return action === 'revoke' || action === 'revoke-grant' || action === 'revoke-credential';
}

function allowedOptions(action: Action): ReadonlySet<string> {
  if (action === 'grant') return new Set(['--app', '--env', '--scope']);
  if (action === 'add-jwk') return new Set(['--label', '--expires-at', '--file']);
  if (action === 'create-secret') return new Set(['--label', '--expires-at']);
  if (isDestructive(action)) return new Set(['--yes']);
  return new Set();
}

function isIsoTimestamp(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value))
  );
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

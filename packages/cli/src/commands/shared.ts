export { formatBytes } from '@noodle-borg/app-audit';

import type { ConfigLocation } from '../config.js';
/**
 * Shared CLI command helpers: usage text plus failure/recovery and tenant-target
 * resolution helpers used across command modules.
 */
import { readConfig } from '../config.js';
import { ServiceRequestError } from '../control-plane.js';
import type { AccessMode } from '../deploy.js';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { type ProjectEntrypointResolution, readProjectLink } from '../project.js';
import {
  isProductionCapacityErrorCode,
  productionCapacityRecovery,
} from './billing-admission-output.js';
import { renderUsageText } from './catalog-render.js';
import { EXIT, type JsonError, printJsonFailure } from './output.js';

type FlagAliases = Readonly<Record<`--${string}`, string>>;
type FlagNames<T extends FlagAliases> = T[keyof T] & string;
export type ParsedCommandFlags<V extends FlagAliases, B extends FlagAliases> = {
  readonly [K in FlagNames<V>]?: string;
} & { readonly [K in FlagNames<B>]: boolean } & {
  readonly positional: readonly string[];
  readonly parseError?: string;
};

/** Parse the common value, boolean, and positional grammar used by hosted CLI commands. */
export function parseCommandFlags<const V extends FlagAliases, const B extends FlagAliases>(
  rest: readonly string[],
  aliases: { readonly values: V; readonly booleans: B },
): ParsedCommandFlags<V, B> {
  const parsed: Record<string, unknown> = { positional: [] };
  for (const name of Object.values(aliases.booleans) as string[]) parsed[name] = false;
  const positional = parsed.positional as string[];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === undefined) continue;
    const booleanName = (aliases.booleans as FlagAliases)[arg as `--${string}`];
    if (booleanName !== undefined) {
      parsed[booleanName] = true;
      continue;
    }
    const valueName = (aliases.values as FlagAliases)[arg as `--${string}`];
    if (valueName !== undefined) {
      const value = rest[index + 1];
      if (value === undefined || value.startsWith('--')) {
        parsed.parseError ??= `${arg} requires a value`;
      } else {
        parsed[valueName] = value;
        index++;
      }
      continue;
    }
    if (arg.startsWith('-')) parsed.parseError ??= `unknown option: ${arg}`;
    else positional.push(arg);
  }
  return parsed as ParsedCommandFlags<V, B>;
}

/**
 * Render a byte count for human CLI output: plain `B` under 1 KiB, else one decimal in KB/MB/GB
 * (1024-based). Shared by deploy summaries and validate's packaged-asset disclosure.
 */

export function usage(write: (message: string) => void = console.error): void {
  write(renderUsageText());
}

/**
 * Preserve the established full human usage screen while giving `--json` callers a canonical
 * failure envelope for handler-owned nested grammars.
 */
export function printCommandUsageFailure(
  command: string,
  message: string,
  next: string,
  json: boolean,
): number {
  if (json) {
    return printJsonFailure(
      {
        code: 'usage_error',
        message,
        cause: `noodle ${command} is missing a required action or positional argument.`,
        fix: 'Pass the required action and positional arguments.',
        next,
      },
      EXIT.USAGE,
    );
  }
  usage();
  return EXIT.USAGE;
}

export function missingProjectEntrypoint(command: string, json = false): number {
  return printCliFailure(
    command,
    {
      code: 'project_entrypoint_required',
      message: 'No project entrypoint found.',
      cause: 'No project entrypoint found.',
      fix: 'Create a project or bind this directory to an existing project entrypoint.',
      next: 'noodle init or noodle link --entrypoint <path>',
      exitCode: EXIT.USAGE,
    },
    json,
  );
}

export function configuredProjectEntrypointMissing(
  command: string,
  resolution: ProjectEntrypointResolution,
  json = false,
): number {
  return printCliFailure(
    command,
    {
      code: 'project_entrypoint_missing',
      message: 'Configured project entrypoint does not exist.',
      cause: `${resolution.source} sets entrypoint to "${resolution.value}", but that file does not exist.`,
      fix: `Re-save or remove the stale ${resolution.source} entrypoint.`,
      next: `noodle link --entrypoint ${resolution.recoveryValue ?? '<path>'}`,
      detail: { source: resolution.source, entrypoint: resolution.value },
      exitCode: EXIT.USAGE,
    },
    json,
  );
}

/**
 * Block until one of `signals` arrives, then run `onStop` and resolve. Shared by long-running local
 * commands (`devtools`) that keep a preview/dev server up until an operator or orchestrator asks it to
 * stop. Deregisters every handler on the first signal so cleanup runs exactly once.
 */
export async function waitForShutdownSignal(
  signals: readonly NodeJS.Signals[],
  onStop: () => Promise<void> | void,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      for (const signal of signals) process.off(signal, stop);
      await onStop();
      resolve();
    };
    for (const signal of signals) process.on(signal, stop);
  });
}

export function isAccessMode(value: string | undefined): value is AccessMode {
  return (
    value === 'owner-only' ||
    value === 'org-members' ||
    value === 'authenticated' ||
    value === 'public' ||
    value === 'mixed' ||
    value === 'customers'
  );
}

export function missingLogin(command: string, json = false): number {
  return printCliFailure(
    command,
    {
      code: 'auth_required',
      message: 'No control-plane login token is available.',
      cause: 'No control-plane login token is available.',
      fix: 'Sign in or pass an explicit auth token for this command.',
      next: 'noodle login',
      exitCode: EXIT.FAILURE,
    },
    json,
  );
}

export type CliFailure = JsonError &
  Required<Pick<JsonError, 'cause' | 'fix' | 'next'>> & {
    readonly exitCode: number;
  };

export function printCliFailure(command: string, failure: CliFailure, json = false): number {
  if (json) {
    const { exitCode, ...error } = failure;
    return printJsonFailure(error, exitCode);
  } else {
    printRecovery({
      command,
      message: failure.message,
      cause: failure.cause,
      fix: failure.fix,
      next: failure.next,
    });
  }
  return failure.exitCode;
}

/**
 * The service's 403 for a credential whose Developer Access Grant does not cover the operation
 * (`authorizeControlPlane`, ADR 0169 §8). It is not an ordinary auth failure: the identity is valid
 * and re-running `noodle login` re-mints the same grant, so the recovery has to be re-authorization
 * with the right organization, environments, and capabilities selected.
 */
const DEVELOPER_GRANT_DENIAL = 'developer grant does not authorize this operation';

/** The control-plane login failure shared by every command that needs a saved auth token. */
export function authRequired(): CliFailure {
  return {
    code: 'auth_required',
    message: 'A control-plane login token is required.',
    cause: 'No control-plane login token is available.',
    fix: 'Sign in or pass an explicit auth token.',
    next: 'noodle login',
    exitCode: EXIT.AUTH,
  };
}

/** Argument-validation failure shared by the org command families. */
export function usageError(message: string, next: string): CliFailure {
  return {
    code: 'usage_error',
    message,
    cause: message,
    fix: 'Check the command arguments.',
    next,
    exitCode: EXIT.USAGE,
  };
}

/** Terminal command failure shared by the org command families. */
export function commandFailure(error: unknown, next: string): CliFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'command_failed',
    message,
    cause: message,
    fix: 'Check command inputs and retry.',
    next,
    exitCode: EXIT.FAILURE,
  };
}

export function serviceFailure(_command: string, error: unknown, next: string): CliFailure {
  if (error instanceof ServiceRequestError) {
    const auth = error.status === 401 || error.status === 403;
    if (error.status === 403 && error.message === DEVELOPER_GRANT_DENIAL) {
      return {
        code: 'developer_grant_insufficient',
        message: error.message,
        cause: error.message,
        fix:
          'This login is scoped to one organization, a fixed environment list, and a fixed set of ' +
          'capabilities. Re-authorize and select the organization and environment you are targeting.',
        next: 'noodle logout && noodle login',
        ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        retryable: false,
        exitCode: EXIT.AUTH,
      };
    }
    const network = error.status === 0;
    const rateLimited = error.status === 429;
    const retryable = network || error.status === 408 || rateLimited || error.status >= 500;
    if (isProductionCapacityErrorCode(error.code)) {
      const recovery = productionCapacityRecovery(error.code, 'unknown');
      return {
        code: recovery.code,
        message: error.message,
        cause: error.message,
        fix: recovery.fix,
        next,
        ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
        retryable,
        ...(error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
        exitCode: 1,
      };
    }
    return {
      code:
        error.code ??
        (auth
          ? 'auth_failed'
          : network
            ? 'service_unreachable'
            : rateLimited
              ? 'rate_limited'
              : 'service_error'),
      message: error.message,
      cause: error.message,
      fix: auth
        ? 'Sign in again and confirm org access.'
        : network
          ? 'Check the service URL and network connection.'
          : 'Check the service response and retry.',
      next: auth ? 'noodle login' : next,
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      retryable,
      ...(error.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      exitCode: auth ? EXIT.AUTH : network ? EXIT.UNREACHABLE : EXIT.FAILURE,
    };
  }
  return {
    code: 'command_failed',
    message: errorMessage(error),
    cause: errorMessage(error),
    fix: 'Check command inputs and retry.',
    next,
    retryable: false,
    exitCode: EXIT.FAILURE,
  };
}

export function parseTenantCommandArgs(rest: readonly string[]): {
  readonly org?: string;
  readonly app?: string;
  readonly targetEnv?: string;
  readonly serverVersion?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
} {
  return parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--env': 'targetEnv',
      '--version': 'serverVersion',
      '--service': 'service',
      '--auth-token': 'authToken',
    },
    booleans: { '--json': 'json' },
  });
}

export function resolveTenantTarget(
  args: {
    readonly org?: string;
    readonly app?: string;
    readonly targetEnv?: string;
    readonly service?: string;
  },
  home: ConfigLocation,
):
  | {
      readonly ok: true;
      readonly org: string;
      readonly app: string;
      readonly env: string;
      readonly serviceUrl?: string;
    }
  | { readonly ok: false; readonly error: CliFailure } {
  const project = readProjectLink();
  const config = readConfig(home);
  const org = args.org ?? project?.org ?? config.defaultOrg;
  const app = args.app ?? project?.app ?? config.defaultApp;
  const targetEnv = args.targetEnv ?? project?.env ?? config.defaultEnv ?? 'prod';
  if (org === undefined || app === undefined) {
    return {
      ok: false,
      error: {
        code: 'target_required',
        message: 'org and app are required',
        cause: 'No org/app target was supplied or saved.',
        fix: 'Pass --org and --app or link the project.',
        next: 'noodle link --org <org> --app <app>',
        exitCode: 2,
      },
    };
  }
  return {
    ok: true,
    org,
    app,
    env: targetEnv,
    ...((args.service ?? project?.serviceUrl ?? config.serviceUrl)
      ? { serviceUrl: args.service ?? project?.serviceUrl ?? config.serviceUrl }
      : {}),
  };
}

import type { RepoConnection as RepoConnectionRecord } from '@noodle-borg/wire-contracts';
import type { ConfigLocation } from '../config.js';
/**
 * Shared substrate for the `noodle github` command family (`github-ops.ts`): the hosted wire
 * types from `@noodle-borg/wire-contracts`, org/app target
 * resolution (flag > link > config; no `--env` — GitHub connections aren't per-env), the flag
 * parser, and every `CliFailure` builder the three verbs share. Extracted from `github-ops.ts`
 * verbatim so the command module stays under the size-gate warn threshold.
 */
import { readConfig } from '../config.js';
import { ServiceRequestError } from '../control-plane.js';
import { readProjectLink } from '../project.js';
import { EXIT } from './output.js';
import { type CliFailure, parseCommandFlags } from './shared.js';

// --- wire types -------------------------------------------------------------------------------

export interface GithubRepository {
  readonly id: number;
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
}

export type { RepoConnectionRecord };

// --- target resolution (org+app; no --env — GitHub connections aren't per-env) -----------------

export interface GithubTarget {
  readonly org: string;
  readonly app: string;
  readonly serviceUrl?: string;
  readonly source: 'flag' | 'link' | 'config';
}

export function resolveGithubTarget(
  args: { readonly org?: string; readonly app?: string; readonly service?: string },
  home: ConfigLocation,
):
  | { readonly ok: true; readonly target: GithubTarget }
  | { readonly ok: false; readonly error: CliFailure } {
  const project = readProjectLink();
  const config = readConfig(home);
  const org = args.org ?? project?.org ?? config.defaultOrg;
  const app = args.app ?? project?.app ?? config.defaultApp;
  const serviceUrl = args.service ?? project?.serviceUrl ?? config.serviceUrl;
  if (org === undefined || app === undefined) {
    return {
      ok: false,
      error: {
        code: 'target_required',
        message: 'org and app are required',
        cause: 'No org/app target was supplied or saved.',
        fix: 'Pass --org and --app, or link the project.',
        next: 'noodle link --org <org> --app <app>',
        exitCode: EXIT.USAGE,
      },
    };
  }
  const source: GithubTarget['source'] =
    args.org !== undefined || args.app !== undefined
      ? 'flag'
      : project !== undefined
        ? 'link'
        : 'config';
  return {
    ok: true,
    target: { org, app, source, ...(serviceUrl !== undefined ? { serviceUrl } : {}) },
  };
}

// --- shared arg parsing ---------------------------------------------------------------------------

export interface GithubArgs {
  readonly org?: string;
  readonly app?: string;
  readonly service?: string;
  readonly authToken?: string;
  readonly json: boolean;
  readonly repo?: string;
  readonly yes: boolean;
}

export function parseGithubArgs(rest: readonly string[]): GithubArgs {
  return parseCommandFlags(rest, {
    values: {
      '--org': 'org',
      '--app': 'app',
      '--service': 'service',
      '--auth-token': 'authToken',
      '--repo': 'repo',
    },
    booleans: { '--json': 'json', '--yes': 'yes' },
  });
}

// --- shared failure builders ------------------------------------------------------------------

export function authRequired(): CliFailure {
  return {
    code: 'auth_required',
    message: 'No control-plane login token is available.',
    cause: 'Hosted GitHub connection commands require an authenticated Noodle Seed Cloud identity.',
    fix: 'Sign in to the target service.',
    next: 'noodle login',
    exitCode: EXIT.AUTH,
  };
}

export function ownerRoleFailure(org: string): CliFailure {
  const message = `Only an org owner can manage the GitHub connection for "${org}"`;
  return {
    code: 'forbidden',
    message,
    cause: `The signed-in identity is not an owner of org "${org}".`,
    fix: 'Ask an org owner to connect the repository, or ask them to grant you the owner role.',
    next: `noodle members list --org ${org}`,
    exitCode: EXIT.AUTH,
  };
}

export function githubAppNotConfiguredFailure(): CliFailure {
  return {
    code: 'github_app_not_configured',
    message: 'The GitHub App is not configured for this service',
    cause: 'The hosted service has no Noodle Seed GitHub App configured yet.',
    fix: 'Ask an operator to configure the Noodle Seed GitHub App for this service.',
    next: 'noodle doctor',
    exitCode: EXIT.FAILURE,
  };
}

export function conflictFailure(org: string, app: string, message: string): CliFailure {
  return {
    code: 'conflict',
    message,
    cause: message,
    fix: 'Disconnect the existing binding first, or choose a different app/repository.',
    next: `noodle github status --org ${org} --app ${app}`,
    exitCode: EXIT.FAILURE,
  };
}

export function repoNotFoundFailure(repo: string, repos: readonly GithubRepository[]): CliFailure {
  return {
    code: 'not_found',
    message: `Repository "${repo}" was not found in this GitHub App installation`,
    cause: `The installation does not include "${repo}".`,
    fix:
      repos.length > 0
        ? `Choose one of: ${repos.map((r) => r.fullName).join(', ')}.`
        : 'Grant the installation access to this repository on GitHub, then retry.',
    next: 'noodle github connect',
    exitCode: EXIT.FAILURE,
  };
}

export function missingRepoAnswerFailure(repos: readonly GithubRepository[]): CliFailure {
  return {
    code: 'missing_answer',
    message: 'Multiple repositories are available; --repo is required',
    cause: 'The GitHub App installation covers more than one repository.',
    fix: `Pass --repo <owner/name>. Available: ${repos.map((r) => r.fullName).join(', ')}.`,
    next: 'noodle github connect --repo <owner/name>',
    exitCode: EXIT.USAGE,
  };
}

export function noRepositoriesFailure(): CliFailure {
  return {
    code: 'no_repositories',
    message: 'The GitHub App installation has no accessible repositories',
    cause: 'No repository was granted to this installation.',
    fix: 'Grant the Noodle Seed Deploys GitHub App access to a repository, then retry.',
    next: 'noodle github connect',
    exitCode: EXIT.FAILURE,
  };
}

export function installTimeoutFailure(): CliFailure {
  return {
    code: 'install_timeout',
    message: 'Timed out waiting for the GitHub installation to complete',
    cause: 'The browser install flow was not completed in time.',
    fix: 'Finish installing the GitHub App in your browser, then retry.',
    next: 'noodle github connect',
    exitCode: EXIT.FAILURE,
  };
}

export function serviceErrorFailure(next: string, error: unknown): CliFailure {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ServiceRequestError ? error.status : undefined;
  const network = status === 0;
  return {
    code: network ? 'service_unreachable' : 'command_failed',
    message,
    cause: message,
    fix: network
      ? 'Check the service URL and network connection.'
      : 'Check command inputs and retry.',
    next,
    exitCode: network ? EXIT.UNREACHABLE : EXIT.FAILURE,
  };
}

import { presentUrl, type UrlOpener } from '../browser.js';
import type { ConfigLocation } from '../config.js';
/**
 * `noodle github connect|status|disconnect` (GHD-1.4): browser-driven GitHub App installation plus the
 * service-backed repository-connection APIs (`packages/deploy-github/src/routes/github-connection.ts` +
 * `github-setup.ts`). `connect` never writes any local state before its final `POST .../github/connection`
 * call — every earlier step (install-url, opening the browser, polling, claiming) is read-only or lives
 * entirely in the service's short-lived nonce/pending state, so a Ctrl-C at any point before that last
 * network call leaves nothing to clean up locally or remotely. Wire types, target resolution, arg
 * parsing, and the failure builders live in the sibling `github-shared.ts`.
 */
import { resolveControlPlaneToken, ServiceRequestError, serviceJson } from '../control-plane.js';
import {
  type DetailCardOptions,
  type DetailRow,
  type DetailTone,
  renderDetailCard,
} from '../detail-card.js';
import { AbortPromptError, confirm, isInteractive, type SelectOption, select } from '../prompts.js';
import { relativeTime } from '../relative-time.js';
import { printStep } from '../status.js';
import { type DeployRun, runGithubRuns } from './github-runs-ops.js';
import {
  authRequired,
  conflictFailure,
  type GithubRepository,
  githubAppNotConfiguredFailure,
  installTimeoutFailure,
  missingRepoAnswerFailure,
  noRepositoriesFailure,
  ownerRoleFailure,
  parseGithubArgs,
  type RepoConnectionRecord,
  repoNotFoundFailure,
  resolveGithubTarget,
  serviceErrorFailure,
} from './github-shared.js';
import { shouldOpenBrowser } from './open-ops.js';
import { EXIT, printJsonOk } from './output.js';
import { dimText, stdoutTableOptions } from './resource-shared.js';
import { printCliFailure } from './shared.js';

// --- connect ------------------------------------------------------------------------------------

export interface GithubConnectDeps {
  /** Injectable browser opener seam; production uses the shared OSS launcher. */
  readonly openBrowser?: UrlOpener;
  /** Poll interval for the install hand-off. Default 2000ms. */
  readonly pollIntervalMs?: number;
  /** Total time to wait for the browser install to land before giving up. Default 5 minutes. */
  readonly pollTimeoutMs?: number;
  /** Injectable sleep, so tests never depend on real timers. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `GET /v1/github/installations/pending?state=` until the browser install flow lands the GitHub
 * Setup URL redirect on the service (`packages/deploy-github/src/routes/github-setup.ts` stores the
 * installationId keyed by the signed state nonce). 404 = not landed yet, keep polling; anything else
 * propagates. Resolves `undefined` on timeout.
 */
async function pollPendingInstallation(
  serviceUrl: string,
  token: string,
  state: string,
  opts: {
    readonly intervalMs: number;
    readonly timeoutMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  },
): Promise<number | undefined> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    try {
      const body = await serviceJson<{ ok: true; data: { installationId: number } }>(
        `${serviceUrl}/v1/github/installations/pending?state=${encodeURIComponent(state)}`,
        token,
      );
      return body.data.installationId;
    } catch (error) {
      if (!(error instanceof ServiceRequestError) || error.status !== 404) throw error;
    }
    if (Date.now() >= deadline) return undefined;
    await opts.sleep(opts.intervalMs);
  }
}

export async function runGithubConnect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  deps: GithubConnectDeps = {},
): Promise<number> {
  const args = parseGithubArgs(rest);
  const json = args.json;
  const resolved = resolveGithubTarget(args, home);
  if (!resolved.ok) return printCliFailure('github', resolved.error, json);
  const { org, app, source } = resolved.target;
  if (!json) printStep('done', `Target: ${org}/${app} (from ${source})`);

  const tokenResolution = await resolveControlPlaneToken({
    serviceFlag: args.service ?? resolved.target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (tokenResolution.token === undefined) return printCliFailure('github', authRequired(), json);
  const { serviceUrl, token } = tokenResolution;

  let installUrl: string;
  let state: string;
  try {
    const body = await serviceJson<{ ok: true; data: { installUrl: string; state: string } }>(
      `${serviceUrl}/v1/github/install-url?org=${encodeURIComponent(org)}&app=${encodeURIComponent(app)}`,
      token,
    );
    installUrl = body.data.installUrl;
    state = body.data.state;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 409) {
      return printCliFailure('github', githubAppNotConfiguredFailure(), json);
    }
    return printCliFailure('github', serviceErrorFailure('noodle github connect', error), json);
  }

  if (!json) {
    printStep('done', 'Opening GitHub to install Noodle Seed Deploys…');
  }
  await presentUrl(installUrl, {
    shouldOpen: deps.openBrowser !== undefined || shouldOpenBrowser(env),
    ...(deps.openBrowser !== undefined ? { open: deps.openBrowser } : {}),
    print: json ? () => {} : (url) => console.log(dimText(url, process.stdout)),
  });

  let landed: number | undefined;
  try {
    landed = await pollPendingInstallation(serviceUrl, token, state, {
      intervalMs: deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      timeoutMs: deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      sleep: deps.sleep ?? defaultSleep,
    });
  } catch (error) {
    return printCliFailure('github', serviceErrorFailure('noodle github connect', error), json);
  }
  if (landed === undefined) return printCliFailure('github', installTimeoutFailure(), json);

  // The claim body carries only the state: the service derives the installationId from the landed
  // setup redirect itself and returns it — a client-supplied id is never trusted.
  let repos: readonly GithubRepository[];
  let installationId: number;
  try {
    const claimBody = await serviceJson<{
      ok: true;
      data: { installationId: number; repositories: readonly GithubRepository[] };
    }>(`${serviceUrl}/v1/github/installations/claim`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    repos = claimBody.data.repositories;
    installationId = claimBody.data.installationId;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 403) {
      return printCliFailure('github', ownerRoleFailure(org), json);
    }
    return printCliFailure('github', serviceErrorFailure('noodle github connect', error), json);
  }

  let chosen: GithubRepository;
  if (args.repo !== undefined) {
    const match = repos.find((r) => r.fullName === args.repo);
    if (match === undefined)
      return printCliFailure('github', repoNotFoundFailure(args.repo, repos), json);
    chosen = match;
  } else if (repos.length === 0) {
    return printCliFailure('github', noRepositoriesFailure(), json);
  } else if (repos.length === 1) {
    chosen = repos[0] as GithubRepository;
    if (!json)
      printStep('done', `Repository: ${chosen.fullName} (only repository in this installation)`);
  } else if (json || !isInteractive()) {
    return printCliFailure('github', missingRepoAnswerFailure(repos), json);
  } else {
    const options: SelectOption<GithubRepository>[] = repos.map((r) => ({
      value: r,
      label: r.fullName,
    }));
    try {
      chosen = await select('Which repository?', options);
    } catch (error) {
      if (error instanceof AbortPromptError) {
        console.error('github connect: cancelled');
        return EXIT.USAGE;
      }
      throw error;
    }
  }

  let record: RepoConnectionRecord;
  try {
    const connectBody = await serviceJson<{ ok: true; data: RepoConnectionRecord }>(
      `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/github/connection`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId, githubRepositoryId: chosen.id }),
      },
    );
    record = connectBody.data;
  } catch (error) {
    if (error instanceof ServiceRequestError) {
      if (error.status === 403) return printCliFailure('github', ownerRoleFailure(org), json);
      if (error.status === 409)
        return printCliFailure('github', conflictFailure(org, app, error.message), json);
    }
    return printCliFailure('github', serviceErrorFailure('noodle github connect', error), json);
  }

  if (json) {
    printJsonOk(record);
    return EXIT.OK;
  }
  printStep('done', `Connected ${record.repoName} → ${org}/${app}`);
  console.log(`repo:    ${record.repoName}`);
  console.log(`branch:  ${record.defaultBranch} → prod`);
  console.log('PRs:     pr-{number} preview environments (activates with deploy-on-push rollout)');
  console.log('Next:    git push deploys once rollout completes — check with noodle github status');
  return EXIT.OK;
}

// --- status --------------------------------------------------------------------------------------

const RUN_STATUS_TONE: Record<DeployRun['status'], DetailTone> = {
  queued: 'attention',
  building: 'attention',
  deploying: 'attention',
  deployed: 'good',
  failed: 'bad',
  canceled: 'dim',
  superseded: 'dim',
};

/**
 * Render the `github status` detail card (approved design 2026-07-06). Connected: the repo name
 * titles the card with target/branch/state/installation/last-run rows (last run toned by its
 * status) and a `noodle github runs` footer. Not connected stays a friendly card: org/app title,
 * attention state, `noodle github connect` footer. Pure; exported for direct tone assertions.
 */
export function renderGithubStatusCard(
  input: {
    readonly org: string;
    readonly app: string;
    readonly record?: RepoConnectionRecord;
    readonly lastRun?: DeployRun;
  },
  opts: DetailCardOptions,
  now: number = Date.now(),
): string {
  if (input.record === undefined) {
    return renderDetailCard(
      `${input.org}/${input.app}`,
      [{ key: 'state', value: 'not connected', tone: 'attention' }],
      opts,
      ['noodle github connect'],
    );
  }
  const lastRun: DetailRow =
    input.lastRun !== undefined
      ? {
          key: 'last run',
          value:
            `${input.lastRun.commitSha.slice(0, 7)} → ${input.lastRun.envName} ` +
            `(${input.lastRun.status}, ${relativeTime(input.lastRun.createdAt, now)})`,
          tone: RUN_STATUS_TONE[input.lastRun.status],
        }
      : {
          key: 'last run',
          value: opts.glyph === 'ascii' ? '-' : '—',
          tone: 'dim',
          note: '(no deploy runs yet)',
        };
  return renderDetailCard(
    input.record.repoName,
    [
      { key: 'target', value: `${input.org}/${input.app}` },
      { key: 'branch', value: `${input.record.defaultBranch} → prod` },
      { key: 'state', value: 'connected', tone: 'good', dot: true },
      {
        key: 'installation',
        value: String(input.record.installationId),
        tone: 'dim',
        note: `(repo #${input.record.githubRepositoryId})`,
      },
      lastRun,
    ],
    opts,
    ['noodle github runs'],
  );
}

async function runGithubStatus(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseGithubArgs(rest);
  const json = args.json;
  const resolved = resolveGithubTarget(args, home);
  if (!resolved.ok) return printCliFailure('github', resolved.error, json);
  const { org, app } = resolved.target;

  const tokenResolution = await resolveControlPlaneToken({
    serviceFlag: args.service ?? resolved.target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (tokenResolution.token === undefined) return printCliFailure('github', authRequired(), json);
  const { serviceUrl, token } = tokenResolution;

  try {
    const body = await serviceJson<{ ok: true; data: RepoConnectionRecord }>(
      `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/github/connection`,
      token,
    );
    const record = body.data;
    // Best-effort last-run line (GHD-2): the runs feed exists now, so status can surface it. A read
    // failure here must never break status itself.
    let lastRun: DeployRun | undefined;
    try {
      const runsBody = await serviceJson<{
        ok: true;
        data: { runs: readonly DeployRun[]; truncated: boolean };
      }>(
        `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/github/runs?limit=1`,
        token,
      );
      lastRun = runsBody.data.runs[0];
    } catch {
      lastRun = undefined;
    }
    if (json) {
      printJsonOk({
        connected: true,
        connection: record,
        ...(lastRun !== undefined ? { lastRun } : {}),
      });
      return EXIT.OK;
    }
    console.log(
      renderGithubStatusCard(
        { org, app, record, ...(lastRun !== undefined ? { lastRun } : {}) },
        stdoutTableOptions(),
      ),
    );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 404) {
      // Not-connected is a read result, not an error — exit 0 with the connect pointer.
      if (json) {
        printJsonOk({ connected: false });
        return EXIT.OK;
      }
      console.log(renderGithubStatusCard({ org, app }, stdoutTableOptions()));
      return EXIT.OK;
    }
    return printCliFailure('github', serviceErrorFailure('noodle github status', error), json);
  }
}

// --- disconnect ------------------------------------------------------------------------------------

async function runGithubDisconnect(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const args = parseGithubArgs(rest);
  const json = args.json;
  const resolved = resolveGithubTarget(args, home);
  if (!resolved.ok) return printCliFailure('github', resolved.error, json);
  const { org, app } = resolved.target;

  if (!args.yes) {
    const interactive = !json && process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      return printCliFailure(
        'github',
        {
          code: 'confirmation_required',
          message: 'disconnect requires confirmation',
          cause: 'This stops GitHub-triggered deploys for the app. Reconnect any time.',
          fix: 'Re-run with --yes to confirm non-interactively.',
          next: `noodle github disconnect --org ${org} --app ${app} --yes`,
          exitCode: EXIT.USAGE,
        },
        json,
      );
    }
    const confirmed = await confirm(
      `This stops GitHub-triggered deploys for ${org}/${app}. Reconnect any time. Disconnect?`,
      { initial: false },
    );
    if (!confirmed) {
      console.error('github disconnect: cancelled');
      return EXIT.USAGE;
    }
  }

  const tokenResolution = await resolveControlPlaneToken({
    serviceFlag: args.service ?? resolved.target.serviceUrl,
    authFlag: args.authToken,
    env,
    home,
  });
  if (tokenResolution.token === undefined) return printCliFailure('github', authRequired(), json);
  const { serviceUrl, token } = tokenResolution;

  try {
    const body = await serviceJson<{ ok: true; data: { disabled: boolean } }>(
      `${serviceUrl}/v1/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/github/connection`,
      token,
      { method: 'DELETE' },
    );
    if (json) {
      printJsonOk(body.data);
      return EXIT.OK;
    }
    console.log(
      body.data.disabled
        ? `Disconnected ${org}/${app}. Reconnect any time with: noodle github connect --org ${org} --app ${app}`
        : `${org}/${app} was already disconnected.`,
    );
    return EXIT.OK;
  } catch (error) {
    if (error instanceof ServiceRequestError && error.status === 403) {
      return printCliFailure('github', ownerRoleFailure(org), json);
    }
    return printCliFailure('github', serviceErrorFailure('noodle github disconnect', error), json);
  }
}

// --- dispatch ------------------------------------------------------------------------------------

export async function runGithub(
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<number> {
  const [action, ...actionRest] = rest;
  if (action === 'connect') return runGithubConnect(actionRest, env, home);
  if (action === 'status') return runGithubStatus(actionRest, env, home);
  if (action === 'disconnect') return runGithubDisconnect(actionRest, env, home);
  if (action === 'runs') return runGithubRuns(actionRest, env, home);
  const json = rest.includes('--json');
  return printCliFailure(
    'github',
    {
      code: 'usage_error',
      message: 'usage: noodle github connect|status|disconnect|runs',
      cause: 'usage: noodle github connect|status|disconnect|runs',
      fix: 'Check the command arguments.',
      next: 'noodle github --help',
      exitCode: EXIT.USAGE,
    },
    json,
  );
}

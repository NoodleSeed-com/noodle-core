/**
 * `noodle start` — the guided first-run wizard.
 *
 * Interactive on a TTY: a restrained, transparent flow that teaches the model,
 * discloses what it does (files + the exact command each step runs), verifies the
 * server actually responds before declaring success, then transitions into the
 * first real job — it does not end at "setup complete".
 *
 * Non-interactive (`--json`, pipes, CI, or an agent): the same flow, flag-driven.
 * Answers come from flags; a missing required answer fails with a machine-readable
 * error naming the flag, never a hung prompt. Nothing animates; output is structured.
 *
 * The wizard orchestrates existing primitives (`browserLogin`, `initProject`,
 * `deploy`, `dev`, the hosted smoke) and reuses the shipped splash + `status`
 * module. It is idempotent and resumable: already-done steps are detected and skipped.
 */
import { basename, extname } from 'node:path';
import { printBanner } from './banner.js';
import {
  completeDeployResume,
  prepareCanonicalDeploy,
  verifyHostedDeploy,
} from './commands/deploy-first-flow.js';
import { type NextCommand, printJsonFailure, printJsonOk } from './commands/output.js';
import type { ConfigLocation } from './config.js';
import { readConfig } from './config.js';
import {
  browserLogin,
  RefreshTokenRejectedError,
  resolveControlPlaneToken,
} from './control-plane.js';
import { type AccessMode, deploy } from './deploy.js';
import { type DevReloadResult, dev } from './dev.js';
import { errorMessage, printRecovery } from './diagnostics.js';
import {
  type ColorMode,
  detectColorMode,
  detectGlyphMode,
  type GlyphMode,
  paint as paintMode,
  type RGB,
} from './gradient.js';
import {
  type InitTemplate,
  readProjectDeployment,
  readResolvedProjectConfig,
  resolveLocalEntrypoint,
  writeProjectLink,
} from './project.js';
import { type BootstrapReport, bootstrapProject } from './project-bootstrap.js';
import {
  AbortPromptError,
  confirm,
  isInteractive,
  MissingAnswerError,
  resolveAnswer,
  type SelectOption,
  select,
  text,
} from './prompts.js';
import { startSpinner } from './status.js';
import { isMissingDependencyError } from './validate.js';

const ORANGE: RGB = [249, 115, 22];
const AMBER: RGB = [245, 158, 11];
const GREEN: RGB = [34, 197, 94];
const INK: RGB = [230, 230, 230];
const DIM: RGB = [125, 125, 125];
const FAINT: RGB = [90, 90, 90];

/** What to do once the server is up: call it, watch it, or keep iterating locally. */
const START_NEXT_COMMANDS: readonly NextCommand[] = [
  { command: 'noodle connect claude-code', reason: 'call your server from your editor' },
  { command: 'noodle logs --tail', reason: 'watch live tool calls' },
  { command: 'noodle dev', reason: 'iterate locally' },
];

export interface StartFlags {
  json: boolean;
  name?: string | undefined;
  template?: string | undefined;
  where?: 'deploy' | 'local' | undefined;
  org?: string | undefined;
  app?: string | undefined;
  env?: string | undefined;
  access?: string | undefined;
  yes: boolean;
  serviceFlag?: string | undefined;
  authFlag?: string | undefined;
}

export function parseFlags(rest: readonly string[]): StartFlags {
  const f: StartFlags = { json: false, yes: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') f.json = true;
    else if (a === '--yes' || a === '-y') f.yes = true;
    else if (a === '--name') f.name = rest[++i];
    else if (a === '--template') f.template = rest[++i];
    else if (a === '--deploy') f.where = 'deploy';
    else if (a === '--local') f.where = 'local';
    else if (a === '--org') f.org = rest[++i];
    else if (a === '--app') f.app = rest[++i];
    else if (a === '--env') f.env = rest[++i];
    else if (a === '--access') f.access = rest[++i];
    else if (a === '--service') f.serviceFlag = rest[++i];
    else if (a === '--auth-token') f.authFlag = rest[++i];
  }
  return f;
}

// --- styled output ---
// Terminal capabilities, resolved once per run in `runStart`.
let COLOR: ColorMode = 'none';
let GLYPH: GlyphMode = 'unicode';
let JSON_MODE = false;
const paint = (rgb: RGB, s: string): string => paintMode(rgb, s, COLOR);
/** Pick a glyph by terminal capability (Unicode vs ASCII fallback). */
const gg = (unicode: string, ascii: string): string => (GLYPH === 'unicode' ? unicode : ascii);
const out = (s: string): void => {
  // cli-output-drift-allow: human-only first-run banner output.
  process.stdout.write(`${s}\n`);
};

/** The orientation header: teach the model + key hints. Interactive only. */
async function orientation(): Promise<void> {
  printBanner();
  out(
    `${paint(DIM, 'You author one ')}${paint(INK, 'server.ts')}${paint(DIM, '. Noodle compiles it and runs it for you:')}`,
  );
  out('');
  const arrow = paint(FAINT, gg('──▶', '-->'));
  out(
    `    ${paint(ORANGE, 'server.ts')} ${arrow} ${paint(DIM, 'compile')} ${arrow} ${paint(DIM, 'manifest')} ${arrow} ${paint(DIM, 'runtime')} ${arrow} ${paint(DIM, 'MCP client')}`,
  );
  out(
    `    ${paint(FAINT, 'you write      noodle        data         we host        Claude, Cursor…')}`,
  );
  out('');
  out(
    `${paint(DIM, 'first-run setup · each step prints its flag ·')} ${paint(FAINT, gg('↑↓ move  ⏎ select  esc back', 'up/down move  enter select  esc back'))}`,
  );
  out(paint([36, 36, 36], gg('─', '-').repeat(70)));
}

/** A settled wizard step line: `✔ [n/N] label   detail          command`. Silent in --json mode. */
function stepLine(n: number, total: number, label: string, detail: string, command: string): void {
  if (JSON_MODE) return;
  const idx = paint(DIM, `[${n}/${total}]`);
  const cmd = command ? paint(FAINT, command) : '';
  out(
    `${paint(GREEN, gg('✔', '+'))} ${idx} ${paint(INK, label)}   ${paint(DIM, detail)}${cmd ? `   ${cmd}` : ''}`,
  );
}

interface WizardState {
  loggedIn: boolean;
  email?: string;
  entrypoint?: string;
  deployed: boolean;
}

function detectState(home: ConfigLocation, cwd: string): Promise<WizardState> {
  return (async () => {
    const config = readConfig(home);
    const entrypoint = resolveLocalEntrypoint(cwd);
    const deployment = readProjectDeployment(cwd);
    return {
      loggedIn: config.identity !== undefined || config.authToken !== undefined,
      ...(config.identity?.email ? { email: config.identity.email } : {}),
      ...(entrypoint ? { entrypoint } : {}),
      deployed: deployment !== undefined,
    };
  })();
}

// --- steps -----------------------------------------------------------------

/** Step: account. Returns { serviceUrl, token, email } or throws with a recovery already printed. */
async function stepAccount(
  flags: StartFlags,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  interactive: boolean,
  n: number,
  total: number,
): Promise<{ serviceUrl: string; token?: string; email?: string }> {
  const existing = await resolveControlPlaneToken({
    ...(flags.serviceFlag ? { serviceFlag: flags.serviceFlag } : {}),
    ...(flags.authFlag ? { authFlag: flags.authFlag } : {}),
    env,
    home,
  });
  if (existing.token !== undefined) {
    const email = readConfig(home).identity?.email;
    stepLine(n, total, 'account', email ? `signed in as ${email}` : 'signed in', '');
    return { serviceUrl: existing.serviceUrl, token: existing.token, ...(email ? { email } : {}) };
  }
  if (!interactive) {
    // Headless: never open a browser. Local starts need no account; the deploy path
    // enforces auth when it actually needs a token (so `start --json --local` works).
    return { serviceUrl: existing.serviceUrl };
  }
  const wants = await confirm('Local checks completed. Sign in to deploy to Noodle?', {
    initial: true,
  });
  if (!wants) return { serviceUrl: existing.serviceUrl };
  const spinner = startSpinner('Signing you in… opening browser');
  try {
    const result = await browserLogin({ serviceUrl: existing.serviceUrl, home });
    const refreshed = await resolveControlPlaneToken({
      ...(flags.serviceFlag ? { serviceFlag: flags.serviceFlag } : {}),
      env,
      home,
    });
    spinner.succeed(`account · signed in as ${result.email ?? 'you'}`);
    return {
      serviceUrl: result.serviceUrl,
      ...(refreshed.token ? { token: refreshed.token } : {}),
      ...(result.email ? { email: result.email } : {}),
    };
  } catch (err) {
    spinner.fail('sign-in failed');
    throw err;
  }
}

/** Step: project. Scaffolds a new project or detects an existing one. Returns the entrypoint. */
async function stepProject(
  flags: StartFlags,
  interactive: boolean,
  state: WizardState,
  n: number,
  total: number,
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
): Promise<{ entrypoint: string; root: string; setup?: BootstrapReport }> {
  if (state.entrypoint) {
    stepLine(n, total, 'project', `found ${state.entrypoint} — using it`, '');
    return { entrypoint: state.entrypoint, root: process.cwd() };
  }
  const name = interactive
    ? await text('Project name', {
        initial: flags.name ?? 'my-server',
        validate: (v) => (v.trim() ? undefined : 'required'),
      })
    : resolveAnswer<string>({ name: flags.name }, 'name', '--name');
  const templateOptions: SelectOption<string>[] = [
    {
      value: 'saas',
      label: 'saas',
      hint: 'embedded-first application with UI and local acceptance tests',
    },
    { value: 'hello', label: 'hello', hint: 'a minimal MCP server' },
    { value: 'http-api', label: 'http-api', hint: 'wrap an existing HTTP API' },
    { value: 'widget', label: 'widget', hint: 'MCP App UI; assistant is an explicit follow-on' },
  ];
  const template = interactive
    ? (flags.template ?? (await select('Template', templateOptions, { initial: 0 })))
    : resolveAnswer<string>({ template: flags.template }, 'template', '--template', 'saas');
  const result = await bootstrapProject(
    {
      dir: name,
      template: template as InitTemplate,
      name,
      agentTargets: ['codex', 'claude-code'],
    },
    { env, configLocation: home, interactive },
  );
  if (!result.setup.ready) throw new StartBootstrapError(result.setup);
  stepLine(
    n,
    total,
    'scaffold',
    `${name} · template ${template}`,
    `noodle init ${name} --template ${template}`,
  );
  if (interactive) {
    const created = result.files.filter(
      (f) => f.action === 'created' || f.action === 'overwritten',
    );
    out(`              ${paint(DIM, `${name}/`)}`);
    for (const f of created.slice(0, 6))
      out(`              ${paint(FAINT, gg('├─', '|-'))} ${paint(INK, f.path)}`);
  }
  return {
    entrypoint: resolveLocalEntrypoint(result.dir) ?? `${result.dir}/server.ts`,
    root: result.dir,
    setup: result.setup,
  };
}

export interface StartResult {
  ok: boolean;
  deploymentId?: string;
  url?: string;
  verified?: boolean;
  proof?: 'local-synthetic' | 'compiled-only' | 'hosted-readiness';
  error?: { code?: string; message: string; fix?: string; next?: string };
}

/**
 * A failed step: for humans, print a recovery; under `--json` stay silent on stdout
 * and carry the error so `runStart` can emit it in the structured payload instead.
 */
function failStep(cause: string, fix: string, next: string, code?: string): StartResult {
  if (!JSON_MODE) printRecovery({ command: 'start', cause, fix, next });
  return { ok: false, error: { ...(code ? { code } : {}), message: cause, fix, next } };
}

/**
 * Map a local-compile failure to its recovery. A fresh (un-`npm install`ed) widget project fails to
 * compile only because React/Vite are missing — a dependency repair, not a manifest error. Reuse the
 * same dependency-aware detection `noodle validate --json` uses so `start --local` returns the actionable
 * `npm install` next step instead of the dead-end "failed to compile → noodle validate". Exported for a
 * focused unit test (the monorepo hoists Vite, so an integration run can't reliably starve deps).
 */
export function localCompileFailStep(errors: DevReloadResult['errors']): StartResult {
  if (isMissingDependencyError(errors ?? [])) {
    return failStep(
      'the local server needs its dependencies installed before it can compile.',
      'Install the project dependencies, then re-run.',
      'npm install',
      'missing_dependency',
    );
  }
  return failStep(
    'the local server failed to compile.',
    'Fix the reported errors and retry.',
    'noodle validate',
  );
}

async function startDestination(
  flags: StartFlags,
  interactive: boolean,
): Promise<'deploy' | 'local'> {
  const whereOptions: SelectOption<'deploy' | 'local'>[] = [
    {
      value: 'local',
      label: 'Validate locally',
      hint: 'no account; keep iterating with noodle dev',
    },
    { value: 'deploy', label: 'Deploy to the cloud', hint: 'sign in after local checks' },
  ];
  return (
    flags.where ??
    (interactive
      ? await select('Where should this server run?', whereOptions, { initial: 0 })
      : 'local')
  );
}

async function runLocal(
  entrypoint: string,
  interactive: boolean,
  n: number,
  total: number,
): Promise<StartResult> {
  const spinner = interactive ? startSpinner('Booting a local server to verify…') : undefined;
  const handle = await dev({
    manifestPath: entrypoint,
    watch: false,
    interactive: false,
    log: () => {},
  });
  try {
    const reload = handle.boot;
    if (!reload.ok) {
      spinner?.fail('local server failed to compile');
      return localCompileFailStep(reload.errors);
    }
    const count = reload.toolNames?.length ?? 0;
    spinner?.succeed(`compiled — ${count} tool declarations; behavior not exercised`);
    stepLine(
      n,
      total,
      'compile',
      `${count} tool declarations; run application acceptance tests next`,
      'noodle validate',
    );
    return { ok: true, verified: false, proof: 'compiled-only' };
  } finally {
    await handle.close();
  }
}

const ACCESS_MODES: readonly AccessMode[] = [
  'owner-only',
  'org-members',
  'authenticated',
  'customers',
];

async function runHostedStart(
  flags: StartFlags,
  home: ConfigLocation,
  interactive: boolean,
  account: { serviceUrl: string; token?: string },
  entrypoint: string,
  root: string,
  n: number,
  total: number,
): Promise<StartResult> {
  // Deploying is the only step that needs an account; enforce it here, not in stepAccount.
  const token = account.token;
  if (token === undefined) {
    return failStep(
      'deploying needs an account.',
      'Sign in first, or pass a token.',
      'noodle login   (or: noodle start --auth-token <token>)',
    );
  }
  // Read the scaffolded/linked project's config from its own root, not the parent dir.
  const defaults = readResolvedProjectConfig(root);
  const config = readConfig(home);
  const org = flags.org ?? defaults.org ?? config.defaultOrg;
  // Resolve the app name once (deploy() would otherwise infer its own), so deploy + smoke agree.
  const app = flags.app ?? defaults.app ?? basename(entrypoint, extname(entrypoint));
  const environment = flags.env ?? defaults.env ?? config.defaultEnv ?? 'prod';
  const access = flags.access ?? 'owner-only';
  if (org === undefined) {
    return failStep(
      'no deployment org resolved.',
      'Pass an org or link the project.',
      'noodle start --org <org>  (or: noodle link)',
    );
  }
  const targetLabel = `${org}/${app}/${environment}`;

  // Consent before the outward, publishing action.
  if (interactive && !flags.yes) {
    const okToDeploy = await confirm(`Deploy to ${targetLabel} (access: ${access})?`, {
      initial: true,
    });
    if (!okToDeploy) {
      out(`${paint(AMBER, gg('⚠', '!'))} deploy skipped`);
      return { ok: false };
    }
  }

  const serverVersion = '1';
  const preparation = await prepareCanonicalDeploy({
    manifestPath: entrypoint,
    serviceUrl: account.serviceUrl,
    token,
    target: { org, app, env: environment },
    accessMode: access as AccessMode,
    serverVersion,
    projectRoot: root,
    noPrompt: !interactive,
    json: flags.json,
    interactive,
    silent: true,
  });
  if (!preparation.ok) {
    return failStep(
      preparation.error.message,
      preparation.error.fix ?? 'Repair the deploy preflight problem and retry.',
      preparation.error.next ?? 'noodle deploy',
      preparation.error.code,
    );
  }

  const spinner = interactive ? startSpinner(`Deploying to ${targetLabel}…`) : undefined;
  const outcome = await deploy({
    manifestPath: entrypoint,
    serviceUrl: account.serviceUrl,
    authToken: token,
    org,
    app,
    env: environment,
    accessMode: access as AccessMode,
    serverVersion,
    ...(preparation.idempotencyKey !== undefined
      ? { idempotencyKey: preparation.idempotencyKey }
      : {}),
  });
  if (!outcome.ok) {
    spinner?.fail(`deploy failed — ${outcome.message}`);
    return failStep(
      outcome.message,
      outcome.stage !== undefined
        ? `Fix the ${outcome.stage} problem and retry.`
        : 'Resolve the error and retry.',
      outcome.message.toLowerCase().includes('secret')
        ? 'noodle secrets set <NAME>  then  noodle start'
        : 'noodle doctor',
    );
  }
  spinner?.succeed(`deployed to ${targetLabel}`);

  // `start` owns the link: persist the resolved deploy target into the project it just deployed, so a
  // later `noodle deploy` reuses it without the user ever running `noodle link`. Idempotent write to the
  // gitignored `.noodle/project.json` at the scaffolded/linked project root, not the parent dir.
  // Best-effort: the deploy already succeeded, so a failed convenience write must not fail the run.
  try {
    writeProjectLink({
      org,
      app,
      env: environment,
      serviceUrl: account.serviceUrl,
      accessMode: access as AccessMode,
      cwd: root,
    });
  } catch {
    // Link persistence is a convenience; ignore write failures (permissions, read-only fs).
  }

  const verifySpinner = interactive ? startSpinner('Verifying the server responds…') : undefined;
  const verification = await verifyHostedDeploy({
    required: preparation.verificationRequired,
    serviceUrl: account.serviceUrl,
    token,
    target: { org, app, env: environment },
  });
  if (!verification.ok) {
    verifySpinner?.warn('deployed, but the server is not responding yet');
    return failStep(
      `deployment ${outcome.deploymentId} exists, but readiness verification failed.`,
      'Inspect hosted logs and health, then safely resume the same deploy.',
      preparation.resumeCommand,
      'deploy_verification_failed',
    );
  }
  verifySpinner?.succeed('verified — server responds');
  completeDeployResume(root, preparation.idempotencyKey);
  stepLine(
    n,
    total,
    'deploy',
    `${targetLabel} · ${access}`,
    `noodle deploy --org ${org} --access ${access}`,
  );
  return {
    ok: true,
    deploymentId: outcome.deploymentId,
    url: outcome.url,
    verified: true,
    proof: 'hosted-readiness',
  };
}

/** After success: transition into the first real job, not a dead-end. */
async function whatNow(result: StartResult, interactive: boolean): Promise<void> {
  out(paint([36, 36, 36], '─'.repeat(70)));
  if (result.verified)
    out(
      `${paint(GREEN, gg('✔', '+'))} ${paint(INK, result.deploymentId ? 'deployed; hosted readiness passed' : 'local synthetic checks passed; customer integration remains unverified')}`,
    );
  else
    out(`${paint(AMBER, gg('⚠', '!'))} ${paint(INK, 'set up — verify when the server is ready')}`);
  if (result.url) out(`   ${paint(DIM, 'endpoint')}  ${paint(INK, result.url)}`);
  out('');
  if (!interactive) {
    out(
      paint(
        DIM,
        result.deploymentId
          ? 'next: noodle connect claude-code · noodle logs --tail · noodle dev'
          : 'next: run application acceptance tests · noodle dev',
      ),
    );
    return;
  }
  const nextOptions: SelectOption<string>[] = [
    ...(result.deploymentId
      ? [
          {
            value: 'connect',
            label: 'Connect Claude Code',
            hint: 'call your server from your editor',
          },
          { value: 'logs', label: 'Watch requests', hint: 'live tool-call log' },
        ]
      : []),
    { value: 'dev', label: 'Iterate locally', hint: 'hot-reload dev loop' },
    { value: 'done', label: 'Done for now', hint: 'drop to shell' },
  ];
  let choice: string;
  try {
    choice = await select('what now?', nextOptions, { initial: 0 });
  } catch {
    return; // esc / abort → just drop to shell
  }
  const hint: Record<string, string> = {
    connect: 'noodle connect claude-code',
    logs: 'noodle logs --tail',
    dev: 'noodle dev',
    done: '',
  };
  const command = hint[choice];
  if (command) out(`${paint(FAINT, gg('↳', '->'))} ${paint(DIM, command)}`);
}

// --- orchestrator ----------------------------------------------------------

class StartBootstrapError extends Error {
  constructor(readonly setup: BootstrapReport) {
    super(
      `Local setup stopped at ${setup.failed?.stage ?? 'verification'}; repair and resume before deployment.`,
    );
  }
}

export async function runStart(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: ConfigLocation,
): Promise<number> {
  const flags = parseFlags(rest);
  const interactive = !flags.json && isInteractive();
  const cwd = process.cwd();

  // Resolve terminal capabilities once (truecolor / 256 / none; Unicode / ASCII).
  JSON_MODE = flags.json;
  COLOR = flags.json ? 'none' : detectColorMode(process.stdout);
  GLYPH = detectGlyphMode();

  try {
    if (flags.access !== undefined && !ACCESS_MODES.includes(flags.access as AccessMode)) {
      const message = `invalid --access value "${flags.access}".`;
      if (flags.json)
        return printJsonFailure({
          code: 'invalid_access',
          message,
          next: 'noodle start --access owner-only',
        });
      printRecovery({
        command: 'start',
        cause: message,
        fix: `Use one of: ${ACCESS_MODES.join(', ')}.`,
        next: 'noodle start --access owner-only',
      });
      return 1;
    }
    if (interactive) await orientation();
    const state = await detectState(home, cwd);

    const where = await startDestination(flags, interactive);
    const total = where === 'deploy' ? 4 : 2;
    const { entrypoint, root, setup } = await stepProject(
      flags,
      interactive,
      state,
      1,
      total,
      env,
      home,
    );
    const local: StartResult = setup?.ready
      ? { ok: true, verified: true, proof: 'local-synthetic' }
      : await runLocal(entrypoint, interactive, 2, total);
    if (setup?.ready) stepLine(2, total, 'local checks', 'synthetic behavior and types passed', '');
    let account: Awaited<ReturnType<typeof stepAccount>> | undefined;
    let result = local;
    if (local.ok && where === 'deploy') {
      account = await stepAccount(flags, env, home, interactive, 3, total);
      result = await runHostedStart(flags, home, interactive, account, entrypoint, root, 4, total);
    }

    if (flags.json) {
      if (result.ok) {
        printJsonOk({
          account: { email: account?.email ?? null },
          entrypoint,
          ...(result.deploymentId ? { deploymentId: result.deploymentId } : {}),
          ...(result.url ? { url: result.url } : {}),
          verified: result.verified ?? false,
          proof: result.proof,
          ...(setup ? { setup } : {}),
          nextCommands: result.deploymentId
            ? START_NEXT_COMMANDS
            : [
                {
                  command: 'noodle dev',
                  reason:
                    'After binding declared configuration, iterate locally; no server was left running.',
                },
              ],
        });
        return 0;
      }
      // An in-band step failure (deploy needs auth, invalid access, deploy failed, local compile
      // failed) already carries a message + recovery hint; normalize it to the failure envelope.
      return printJsonFailure(
        {
          code: result.error?.code ?? 'error',
          message: result.error?.message ?? 'start did not complete',
          ...(result.error?.fix ? { fix: result.error.fix } : {}),
          ...(result.error?.next ? { next: result.error.next } : {}),
        },
        1,
      );
    }
    if (!result.ok) return 1;
    await whatNow(result, interactive);
    out('');
    out(paint(DIM, 'scriptable · no prompts, no ANSI:  noodle start --json'));
    return 0;
  } catch (err) {
    if (err instanceof StartBootstrapError) {
      if (flags.json)
        return printJsonFailure({
          code: 'bootstrap_failed',
          message: err.message,
          next: err.setup.resumeCommand,
          detail: { setup: err.setup },
        });
      printRecovery({
        command: 'start',
        cause: err.message,
        fix: 'Preserve your files and retry the failed setup step.',
        next: err.setup.resumeCommand,
      });
      return 1;
    }
    if (err instanceof RefreshTokenRejectedError) throw err;
    if (err instanceof AbortPromptError) {
      out(
        paint(DIM, '\nCancelled. Re-run `noodle start` any time — it resumes where you left off.'),
      );
      return 130;
    }
    if (err instanceof MissingAnswerError) {
      if (flags.json) {
        return printJsonFailure(
          { code: 'missing_answer', message: err.message, next: 'noodle start --help' },
          2,
        );
      }
      printRecovery({
        command: 'start',
        cause: err.message,
        fix: 'Supply the flag, or run interactively.',
        next: 'noodle start --help',
      });
      return 2;
    }
    if (flags.json) {
      return printJsonFailure(
        { code: 'error', message: errorMessage(err), next: 'noodle doctor' },
        1,
      );
    }
    printRecovery({
      command: 'start',
      cause: errorMessage(err),
      fix: 'Resolve the error and retry.',
      next: 'noodle doctor',
    });
    return 1;
  }
}

#!/usr/bin/env node
/**
 * `noodle` — the Noodle CLI by Noodle Seed for the hosted workflow.
 *
 *   noodle login
 *   noodle deploy app.ts
 *   noodle whoami | logout | list
 *
 * `deploy` POSTs a manifest/authored server to a deploy service and prints the working tenant MCP
 * endpoint. Service URL and auth token resolve **flag > env > config > default**
 * (config = `~/.noodle/config.json`, written by `login`).
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runAgents } from './agents.js';
import { runAlerts } from './commands/alerts-ops.js';
import { runEvents, runMetrics } from './commands/analytics-ops.js';
import { runApps } from './commands/apps-ops.js';
import { runArchive, runRestore } from './commands/archive-ops.js';
import { runAssistant } from './commands/assistant-ops.js';
import { runAudit } from './commands/audit-ops.js';
import { runAuth } from './commands/auth-ops.js';
import {
  runDev,
  runSmoke as runLocalSmoke,
  runLocalTest,
  runValidate,
} from './commands/author-loop.js';
import { runBilling } from './commands/billing-ops.js';
import { handleUnknownCommand, interceptCatalogHelp } from './commands/catalog-dispatch.js';
import { runCommands } from './commands/commands-ops.js';
import { runConfigValues } from './commands/config-values.js';
import { runConnect } from './commands/connect.js';
import { runDeploy } from './commands/deploy-ops.js';
import { runAccess, runRollback, runStatus } from './commands/deploy-status-ops.js';
import { runDeployments } from './commands/deployments-ops.js';
import { runDesign } from './commands/design.js';
import { runDevtools } from './commands/devtools.js';
import { runHostedSmoke, runInspect } from './commands/diagnostics-ops.js';
import { runDistributions } from './commands/distributions-ops.js';
import { runEnvs } from './commands/envs-ops.js';
import { runFeatures } from './commands/features.js';
import { runFeedback } from './commands/feedback-ops.js';
import { runGithub } from './commands/github-ops.js';
import { runIntents } from './commands/intents-ops.js';
import { runKnowledge } from './commands/knowledge.js';
import { runLogs } from './commands/logs-ops.js';
import { runCheck } from './commands/mcp-apps.js';
import { runOpen } from './commands/open-ops.js';
import { runMembers, runOrgs } from './commands/org-admin.js';
import { EXIT, printJsonFailure } from './commands/output.js';
import { runPlatformAccountReset } from './commands/platform-account-reset-ops.js';
import { runPlatformAuthMigration } from './commands/platform-auth-migration-ops.js';
import { runPolicy } from './commands/policy-ops.js';
import {
  runDocs,
  runExport,
  runImport,
  runInit,
  runLink,
  runSetup,
} from './commands/project-setup.js';
import { runServiceCommand } from './commands/service-ops.js';
import { runLogin, runLogout, runTarget, runWhoami } from './commands/session.js';
import { usage } from './commands/shared.js';
import { runSolutions } from './commands/solutions-ops.js';
import { runUpdateCommand } from './commands/update-ops.js';
import type { ConfigLocation } from './config.js';
import { RefreshTokenRejectedError } from './control-plane.js';
import { runDoctor } from './doctor.js';
import { runStart } from './first-run.js';
import { offerFirstRun } from './first-run-entry.js';
import { enforcePlatformSupport } from './platform-support.js';
import {
  BuildRunConflictError,
  recordManagedInvocation,
} from './plugin-mode/build-readiness-recorder.js';
import { runBuildReadinessStdio } from './plugin-mode/build-readiness-server.js';
import { BuildReadinessStoreLockError } from './plugin-mode/build-readiness-store.js';
import { readPluginCompatibility } from './plugin-mode/compatibility.js';
import { bootstrapPluginMcpInvocation } from './plugin-mode/plugin-mcp-bootstrap.js';
import {
  assertPluginInvocation,
  type PluginMode,
  PluginModeError,
  resolvePluginMode,
} from './plugin-mode/profile.js';
import { currentCliVersion } from './update.js';
import { maybeCheckForCliUpdate } from './update-check.js';

export async function run(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<number> {
  const platformExit = enforcePlatformSupport(argv, process.platform);
  if (platformExit !== undefined) return platformExit;

  let pluginMode: PluginMode | undefined;
  let effectiveArgv = argv;
  let effectiveEnv = env;
  try {
    const bootstrapped = await bootstrapPluginMcpInvocation(argv, {
      env,
      home,
      cliVersion: currentCliVersion(),
    });
    effectiveArgv = bootstrapped?.argv ?? argv;
    effectiveEnv = bootstrapped?.env ?? env;
    pluginMode = resolvePluginMode(effectiveEnv);
    if (pluginMode !== undefined) {
      readPluginCompatibility(pluginMode.compatibilityFile);
      assertPluginInvocation(effectiveArgv);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = error instanceof PluginModeError ? EXIT.USAGE : EXIT.FAILURE;
    if (argv.includes('--json')) {
      return printJsonFailure(
        {
          code:
            error instanceof PluginModeError ? 'plugin_mode_invalid' : 'plugin_bootstrap_failed',
          message: `plugin: ${message}`,
          fix: 'Repair the signed plugin invocation metadata and retry.',
          next: 'Reinstall or reconnect the plugin from its host.',
        },
        exitCode,
      );
    }
    console.error(`plugin: ${message}`);
    return exitCode;
  }
  const [command, ...rest] = effectiveArgv;
  const commandEnv =
    pluginMode === undefined ? effectiveEnv : withoutAmbientAuthOverrides(effectiveEnv);
  const configLocation: ConfigLocation =
    pluginMode === undefined ? home : { configHome: pluginMode.configHome };
  let code: number;
  try {
    code =
      pluginMode === undefined
        ? await runCommand(command, rest, commandEnv, configLocation, pluginMode)
        : await recordManagedInvocation(
            {
              command,
              argv: rest,
              cwd: process.cwd(),
              pluginMode,
            },
            () => runCommand(command, rest, commandEnv, configLocation, pluginMode),
          );
  } catch (error) {
    if (error instanceof RefreshTokenRejectedError) {
      if (effectiveArgv.includes('--json')) {
        return printJsonFailure(
          {
            code: 'auth_session_expired',
            message: 'Your Noodle login has expired.',
            cause: error.message,
            fix: 'Sign in again.',
            next: 'noodle login',
          },
          EXIT.AUTH,
        );
      }
      console.error('Your Noodle login has expired.');
      console.error('Re-login: noodle login');
      return EXIT.AUTH;
    }
    if (
      !(error instanceof BuildRunConflictError) &&
      !(error instanceof BuildReadinessStoreLockError)
    )
      throw error;
    if (effectiveArgv.includes('--json')) {
      return printJsonFailure(
        {
          code: 'plugin_invocation_failed',
          message: `plugin: ${error.message}`,
          fix: 'Wait for the active managed build to finish, then retry.',
          next: 'Retry the same plugin command.',
        },
        EXIT.FAILURE,
      );
    }
    console.error(`plugin: ${error.message}`);
    return EXIT.FAILURE;
  }
  if (code === 0) {
    if (pluginMode !== undefined) return code;
    // The passive check never changes the user's exit code except under the
    // explicit NOODLE_UPDATE_MODE=check contract (overlay 10 = update available).
    const overlay = await maybeCheckForCliUpdate({ command, argv: rest, env, home }).catch(
      () => undefined,
    );
    if (overlay !== undefined) return overlay;
  }
  return code;
}

function withoutAmbientAuthOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NOODLE_AUTH_TOKEN: _authToken, NOODLE_SERVICE_URL: _serviceUrl, ...pluginEnv } = env;
  return pluginEnv;
}

async function runCommand(
  command: string | undefined,
  rest: readonly string[],
  env: NodeJS.ProcessEnv,
  home: ConfigLocation,
  pluginMode: PluginMode | undefined,
): Promise<number> {
  // Catalog-driven interception, ahead of the dispatch switch: `--help`/`-h` on any known verb,
  // and bare-noun/unknown-subcommand help for the subcommand dispatchers (apps, envs, secrets,
  // ...). See commands/catalog-dispatch.ts for exactly which commands this applies to and why.
  const intercepted = interceptCatalogHelp(command, rest);
  if (intercepted !== undefined) return intercepted;

  switch (command) {
    case '--help':
    case '-h':
    case 'help':
      usage(console.log);
      return 0;
    case '--version':
    case '-v':
    case 'version':
      console.log(currentCliVersion());
      return 0;
    case 'commands':
      return runCommands(rest);
    case 'features':
      return runFeatures(rest);
    case 'start':
      return runStart(rest, env, home);
    case undefined:
      return offerFirstRun(env, home);
    case 'update':
      return runUpdateCommand(rest, { env });
    case 'init':
      return runInit(rest, env, home);
    case 'setup':
      return runSetup(rest, env, home);
    case 'link':
      return runLink(rest);
    case 'doctor':
      return runDoctor({ rest, env, home });
    case 'agents':
      return runAgents(rest, env, home);
    case 'auth':
      return runAuth(rest, env, home);
    case 'docs':
      return runDocs(rest);
    case 'connect':
      return runConnect(rest);
    case 'import':
      return runImport(rest, env);
    case 'export':
      return runExport(rest);
    case 'validate':
      return runValidate(rest);
    case 'check':
      return runCheck(rest);
    case 'test':
      return runLocalTest(rest, home);
    case 'tools':
      return runLocalSmoke('tools', rest, home);
    case 'resources':
      return runLocalSmoke('resources', rest, home);
    case 'prompts':
      return runLocalSmoke('prompts', rest, home);
    case 'plugin-mcp': // internal
      if (pluginMode === undefined) {
        console.error('plugin-mcp: this internal command requires signed plugin mode.');
        return EXIT.USAGE;
      }
      await runBuildReadinessStdio({
        workspaceRoot: process.cwd(),
        pluginMode,
        ...(process.argv[1] === undefined ? {} : { cliEntrypoint: process.argv[1] }),
      });
      return EXIT.OK;
    case 'dev':
      return runDev(rest, env, home);
    case 'devtools':
      return runDevtools(rest, home);
    case 'design':
      return runDesign(rest);
    case 'audit':
      return runAudit(rest, env, home);
    case 'knowledge':
      return runKnowledge(rest, env, home);
    case 'billing':
      return runBilling(rest, env, home);
    case 'logs':
      return runLogs(rest, env, home);
    case 'metrics':
      return runMetrics(rest, env, home);
    case 'events':
      return runEvents(rest, env, home);
    case 'alerts':
      return runAlerts(rest, env, home);
    case 'intents':
      return runIntents(rest, env, home);
    case 'assistant':
      return runAssistant(rest, env, home);
    case 'policy':
      return runPolicy(rest, env, home);
    case 'platform-auth':
      return rest[0] === 'account-reset'
        ? runPlatformAccountReset(rest, env, home)
        : runPlatformAuthMigration(rest, env, home);
    case 'deploy':
      return runDeploy(rest, env, home, pluginMode);
    case 'open':
      return runOpen(rest, env, home);
    case 'status':
      return runStatus(rest, env, home);
    case 'inspect':
      return runInspect(rest, env, home);
    case 'smoke':
      return runHostedSmoke(rest, env, home);
    case 'rollback':
      return runRollback(rest, env, home, pluginMode);
    case 'archive':
      return runArchive(rest, env, home);
    case 'restore':
      return runRestore(rest, env, home);
    case 'access':
      return runAccess(rest, env, home);
    case 'apps':
      return runApps(rest, env, home);
    case 'envs':
      return runEnvs(rest, env, home);
    case 'deployments':
      return runDeployments(rest, env, home);
    case 'distributions':
      return runDistributions(rest, env, home);
    case 'service':
      return runServiceCommand(rest, env, home);
    case 'solutions':
      return runSolutions(rest, env, home);
    case 'login':
      return runLogin(rest, env, home, pluginMode);
    case 'logout':
      return runLogout(home, pluginMode);
    case 'whoami':
      return runWhoami(env, home, rest);
    case 'feedback':
      return runFeedback(rest, env, home);
    case 'list':
      return runListMoved(rest);
    case 'orgs':
      return runOrgs(rest, env, home);
    case 'members':
      return runMembers(rest, env, home);
    case 'github':
      return runGithub(rest, env, home);
    case 'keys':
      console.error(
        'keys: caller-key management has been removed; use identity access modes instead',
      );
      return 2;
    case 'target':
      return runTarget(rest, home);
    case 'secrets':
      return runConfigValues('secret', rest, env, home);
    case 'variables':
      return runConfigValues('variable', rest, env, home);
    default:
      return handleUnknownCommand(command, rest);
  }
}

/**
 * `noodle list` was promoted to `noodle deployments list` (ADR 0128 D4): a hard recovery error,
 * not a silent alias, per the one-canonical-way rule.
 */
function runListMoved(rest: readonly string[]): number {
  if (rest.includes('--json')) {
    return printJsonFailure(
      {
        code: 'command_moved',
        message: 'noodle list moved',
        fix: 'Use noodle deployments list',
        next: 'noodle deployments list',
      },
      EXIT.USAGE,
    );
  } else {
    console.error('list: `noodle list` moved. Use: noodle deployments list');
  }
  return EXIT.USAGE;
}

function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
}

// Run only when invoked directly as the bin (not when imported by tests).
if (isDirectInvocation()) {
  run(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

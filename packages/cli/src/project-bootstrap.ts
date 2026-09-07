import { resolve } from 'node:path';
import type { AgentTarget } from '@noodle-borg/agent-kit';
import { type AgentSetupReport, setupAgentsWithResolvedSkills } from './agents.js';
import { type DocsMcpResult, writeDocsMcpConfig } from './commands/docs-mcp.js';
import type { ConfigLocation } from './config.js';
import { type InitProjectOptions, type InitProjectResult, initProject } from './project.js';
import {
  bootstrapDependencyFingerprint,
  bootstrapLockfiles,
  hasCompletedBootstrapLock,
  installedBootstrapCli,
  readBootstrapManifest,
} from './project-bootstrap-install.js';
import {
  assertBootstrapLaunchAllowed,
  type BootstrapLaunchTarget,
  isRunningCodingAgent,
  launchBootstrapAgent,
} from './project-bootstrap-launch.js';
import { type BootstrapExecutor, runBootstrapProcess } from './project-bootstrap-process.js';
import { type BootstrapReport, bootstrapJsonSucceeded } from './project-bootstrap-report.js';

export type { BootstrapReport } from './project-bootstrap-report.js';

import {
  type BootstrapStage,
  type BootstrapState,
  readBootstrapState,
  writeBootstrapState,
} from './project-bootstrap-state.js';
import {
  installArguments,
  type ProjectPackageManager,
  selectPackageManager,
} from './project-toolchain.js';
import { currentCliVersion } from './update.js';

export interface BootstrapProjectOptions extends InitProjectOptions {
  readonly install?: boolean;
  readonly packageManager?: ProjectPackageManager;
  readonly launch?: BootstrapLaunchTarget;
  readonly docsMcp?: boolean;
}
export interface BootstrapProjectResult extends InitProjectResult {
  readonly agents?: AgentSetupReport;
  readonly setup: BootstrapReport;
  readonly docsMcp?: DocsMcpResult;
  readonly warnings?: readonly string[];
}
interface BootstrapDependencies {
  readonly env: NodeJS.ProcessEnv;
  readonly configLocation?: ConfigLocation;
  readonly execute?: BootstrapExecutor;
  readonly setupContext?: typeof setupAgentsWithResolvedSkills;
  readonly interactive?: boolean;
  readonly launchAgent?: typeof launchBootstrapAgent;
  readonly chooseAgent?: (
    agents: readonly AgentTarget[],
    env: NodeJS.ProcessEnv,
  ) => Promise<BootstrapLaunchTarget>;
  readonly progress?: (stage: BootstrapStage, status: 'running' | 'complete') => void;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function agentSelection(agents: readonly AgentTarget[]): string {
  return agents.length === 2 ? 'all' : (agents[0] ?? 'none');
}

/** One canonical local orchestration shared by init and the guided first-run projection. */
export async function bootstrapProject(
  options: BootstrapProjectOptions,
  dependencies: BootstrapDependencies,
): Promise<BootstrapProjectResult> {
  const project = resolve(options.dir ?? '.');
  const agents = options.agentTargets ?? ['codex', 'claude-code'];
  let launch = options.launch ?? 'none';
  assertBootstrapLaunchAllowed(
    launch,
    agents,
    dependencies.interactive ?? false,
    dependencies.env,
    options.install !== false,
  );
  const previous = readBootstrapState(project);
  const manifest = readBootstrapManifest(project);
  const manager = selectPackageManager({
    ...(options.packageManager
      ? { requested: options.packageManager }
      : previous
        ? { requested: previous.packageManager }
        : {}),
    ...(manifest?.packageManager ? { packageManager: manifest.packageManager } : {}),
    lockfiles: bootstrapLockfiles(project),
    ...(dependencies.env.npm_config_user_agent
      ? { userAgent: dependencies.env.npm_config_user_agent }
      : {}),
  });
  const version = currentCliVersion();
  const resume = () =>
    `npx --yes @noodleseed/one@${version} init ${quote(project)} --package-manager ${manager} --agents ${agentSelection(agents)}${options.docsMcp === false ? ' --no-docs-mcp' : ''}${launch === 'none' ? '' : ` --launch ${launch}`}`;
  if (!options.dryRun) dependencies.progress?.('scaffold', 'running');
  const result = initProject(options);
  let state: BootstrapState = {
    schemaVersion: 1,
    cliVersion: version,
    packageManager: manager,
    completed: [],
  };
  let agentReport: AgentSetupReport | undefined;
  let docsMcpReport: DocsMcpResult | undefined;
  const warnings: string[] = [];
  const connectDocs = () => {
    if (options.docsMcp !== false && agents.length) {
      try {
        docsMcpReport = writeDocsMcpConfig(project, { dryRun: options.dryRun ?? false });
      } catch {
        warnings.push(
          'Docs MCP configuration was preserved but could not be reconciled; inspect .mcp.json and re-run init --no-install.',
        );
      }
    }
  };
  const execute = dependencies.execute ?? runBootstrapProcess;
  const processOptions = {
    cwd: project,
    env: { ...dependencies.env, NOODLE_DISABLE_UPDATE_CHECK: '1' },
  };
  const save = () => {
    if (!options.dryRun && options.install !== false) writeBootstrapState(project, state);
  };
  const begin = (stage: BootstrapStage) => {
    state = { ...state, inProgress: stage };
    save();
    dependencies.progress?.(stage, 'running');
  };
  const complete = (stage: BootstrapStage) => {
    const { inProgress: _inProgress, failed: _failed, ...rest } = state;
    state = { ...rest, completed: [...state.completed.filter((value) => value !== stage), stage] };
    save();
    dependencies.progress?.(stage, 'complete');
  };
  const report = (failed?: NonNullable<BootstrapState['failed']>): BootstrapProjectResult => {
    if (failed) {
      const { inProgress: _inProgress, ...rest } = state;
      state = { ...rest, failed };
      save();
    }
    const ready = !failed && state.completed.includes('types');
    const resumeCommand = resume();
    return {
      ...result,
      ...(agentReport ? { agents: agentReport } : {}),
      ...(docsMcpReport ? { docsMcp: docsMcpReport } : {}),
      ...(warnings.length ? { warnings } : {}),
      setup: {
        ready,
        packageManager: manager,
        completed: state.completed,
        ...(failed ? { failed } : {}),
        resumeCommand,
        nextSteps: ready
          ? [
              {
                command: `${manager} run dev`,
                reason:
                  'After binding declared configuration, adapt and test your real application boundary; synthetic proof is not customer or hosted verification.',
              },
            ]
          : [
              {
                command: resumeCommand,
                reason: failed
                  ? failed.code === 'package_manager_unsupported'
                    ? 'Yarn cannot install this release’s bundled runtime. Preserve this project; use --no-install for files-only work, or choose npm/pnpm in a separate project. Do not replace its lockfile.'
                    : failed.code === 'dependency_mismatch'
                      ? 'The existing project pins a different CLI release. Use that pinned CLI, or explicitly review an SDK upgrade before resuming; setup does not silently rewrite package.json.'
                      : `Repair the ${failed.stage} step (${failed.code}), then resume without overwriting customer files.`
                  : 'Install dependencies and run local verification when ready.',
              },
            ],
        restartRequired: agents.length > 0 && !state.completed.includes('launch'),
        proof: ready ? 'local-synthetic' : 'unverified',
      },
    };
  };
  if (options.dryRun) {
    if (agents.length)
      agentReport = await (dependencies.setupContext ?? setupAgentsWithResolvedSkills)(
        { agents, project, write: false, force: options.force ?? false, json: true },
        processOptions.env,
        dependencies.configLocation,
      );
    connectDocs();
    return report();
  }
  complete('scaffold');
  let cli: string | undefined;
  if (options.install !== false) {
    begin('install');
    if (manager === 'yarn')
      return report({ stage: 'install', code: 'package_manager_unsupported' });
    const localManifest = readBootstrapManifest(project);
    if (
      (localManifest?.devDependencies?.['@noodleseed/one'] ??
        localManifest?.dependencies?.['@noodleseed/one']) !== version
    )
      return report({ stage: 'install', code: 'dependency_mismatch' });
    const detected = await execute(manager, ['--version'], {
      ...processOptions,
      timeoutMs: 10_000,
      maxOutputBytes: 1024,
    });
    if (!detected.ok) return report({ stage: 'install', code: detected.code });
    const managerVersion = detected.stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(managerVersion))
      return report({ stage: 'install', code: 'verification_failed' });
    if (
      localManifest?.packageManager &&
      localManifest.packageManager !== `${manager}@${managerVersion}`
    )
      return report({ stage: 'install', code: 'configuration_conflict' });
    state = { ...state, managerVersion };
    cli = installedBootstrapCli(project, version);
    const unchanged =
      previous?.completed.includes('install') &&
      previous.cliVersion === version &&
      previous.managerVersion === managerVersion &&
      previous.packageManager === manager &&
      previous.dependencyFingerprint === bootstrapDependencyFingerprint(project) &&
      cli !== undefined;
    if (!unchanged) {
      const installed = await execute(
        manager,
        installArguments(manager, managerVersion, hasCompletedBootstrapLock(project, manager)),
        processOptions,
      );
      if (!installed.ok) return report({ stage: 'install', code: installed.code });
      cli = installedBootstrapCli(project, version);
      if (!cli || !hasCompletedBootstrapLock(project, manager))
        return report({ stage: 'install', code: 'verification_failed' });
    }
    state = { ...state, dependencyFingerprint: bootstrapDependencyFingerprint(project) };
    complete('install');
  }
  if (agents.length > 0) {
    begin('context');
    try {
      agentReport = await (dependencies.setupContext ?? setupAgentsWithResolvedSkills)(
        { agents, project, write: true, force: options.force ?? false, json: true },
        processOptions.env,
        dependencies.configLocation,
      );
      connectDocs();
      if (!agentReport.ok || agentReport.files.some((file) => file.action === 'skipped'))
        return report({ stage: 'context', code: 'context_invalid' });
      if (cli) {
        const verified = await execute(
          process.execPath,
          [
            cli,
            'agents',
            'doctor',
            '--project',
            project,
            '--agents',
            agentSelection(agents),
            '--json',
          ],
          processOptions,
        );
        if (!verified.ok) return report({ stage: 'context', code: verified.code });
        if (!bootstrapJsonSucceeded(verified.stdout))
          return report({ stage: 'context', code: 'verification_failed' });
      }
      complete('context');
    } catch {
      return report({ stage: 'context', code: 'context_invalid' });
    }
  }
  if (!cli) return report();
  for (const [stage, command, args] of [
    ['validate', process.execPath, [cli, 'validate', '--json']],
    ['behavior', manager, ['run', 'test']],
    ['types', manager, ['run', 'typecheck']],
  ] as const) {
    begin(stage);
    const checked = await execute(command, args, processOptions);
    if (!checked.ok) return report({ stage, code: checked.code });
    if (stage === 'validate' && !bootstrapJsonSucceeded(checked.stdout))
      return report({ stage, code: 'verification_failed' });
    complete(stage);
  }
  if (
    options.launch === undefined &&
    !previous &&
    !manifest &&
    dependencies.interactive &&
    !isRunningCodingAgent(dependencies.env) &&
    agents.length &&
    dependencies.chooseAgent
  ) {
    launch = await dependencies.chooseAgent(agents, dependencies.env);
    assertBootstrapLaunchAllowed(launch, agents, true, dependencies.env, true);
  }
  if (launch !== 'none') {
    if (previous?.completed.includes('launch') && previous.launchedAgent === launch) {
      state = { ...state, launchedAgent: launch };
      complete('launch');
    } else {
      begin('launch');
      const launched = await (dependencies.launchAgent ?? launchBootstrapAgent)(
        launch,
        project,
        dependencies.env,
      );
      if (!launched.ok) return report({ stage: 'launch', code: launched.code });
      state = { ...state, launchedAgent: launch };
      complete('launch');
    }
  }
  return report();
}

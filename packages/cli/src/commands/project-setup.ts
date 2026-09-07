/**
 * Project bootstrap and onboarding commands: init, link, docs export, connect guidance, and setup.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type AgentTarget, parseAgentTargets } from '@noodle-borg/agent-kit';
import {
  runExportAnthropicConnector as runAnthropicConnector,
  runExportClaudePlugin as runClaude,
  runExportOpenAiPlugin as runOpenAi,
} from '@noodle-borg/plugin-distribution/command';
import { setupAgentsWithResolvedSkills } from '../agents.js';
import type { ConfigLocation } from '../config.js';
import { type AccessMode, readDeployInput } from '../deploy.js';
import { errorMessage, printRecovery } from '../diagnostics.js';
import { compileLocalInput as compileLocal } from '../local-compile.js';
import {
  type InitTemplate,
  noodleProjectConfigPath,
  readResolvedProjectConfig,
  relativeEntrypoint,
  resolveConventionalEntrypoint,
  resolveLocalEntrypoint,
  writeNoodleProjectConfig,
  writeProjectLink,
} from '../project.js';
import { bootstrapProject } from '../project-bootstrap.js';
import { type BootstrapLaunchTarget, chooseBootstrapAgent } from '../project-bootstrap-launch.js';
import { BOOTSTRAP_STAGES } from '../project-bootstrap-state.js';
import { isProjectPackageManager, type ProjectPackageManager } from '../project-toolchain.js';
import { isInteractive } from '../prompts.js';
import { EXIT, printJsonFailure, printJsonOk } from './output.js';
import { isAccessMode, missingProjectEntrypoint } from './shared.js';

export { runImport } from './import.js';

export async function runInit(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  configLocation?: ConfigLocation,
): Promise<number> {
  let dir: string | undefined;
  let template: InitTemplate | undefined;
  let name: string | undefined;
  let force = false;
  let dryRun = false;
  let install = true;
  let packageManager: ProjectPackageManager | undefined;
  let launch: BootstrapLaunchTarget | undefined;
  const json = rest.includes('--json');
  let docsMcp = true;
  let agents: readonly AgentTarget[] = ['codex', 'claude-code'];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--template') {
      const value = rest[++i];
      if (value === 'saas' || value === 'hello' || value === 'http-api' || value === 'widget')
        template = value;
      else {
        if (json) {
          return printJsonFailure(
            {
              code: 'invalid_template',
              message: 'init: --template must be saas, hello, http-api, or widget',
              fix: 'Choose one of the supported project templates.',
              next: 'noodle init --template <saas|hello|http-api|widget> --json',
            },
            EXIT.USAGE,
          );
        }
        console.error('init: --template must be saas, hello, http-api, or widget');
        return EXIT.USAGE;
      }
    } else if (arg === '--package-manager') {
      const value = rest[++i];
      if (!isProjectPackageManager(value)) {
        const message = 'init: --package-manager must be npm, pnpm, or yarn';
        if (json)
          return printJsonFailure(
            { code: 'invalid_package_manager', message, next: 'noodle init --help' },
            EXIT.USAGE,
          );
        console.error(message);
        return EXIT.USAGE;
      }
      packageManager = value;
    } else if (arg === '--launch') {
      const value = rest[++i];
      if (value !== 'none' && value !== 'codex' && value !== 'claude-code') {
        const message = 'init: --launch must be codex, claude-code, or none';
        if (json)
          return printJsonFailure(
            { code: 'invalid_launch', message, next: 'noodle init --help' },
            EXIT.USAGE,
          );
        console.error(message);
        return EXIT.USAGE;
      }
      launch = value;
    } else if (arg === '--no-install') install = false;
    else if (arg === '--name') name = rest[++i];
    else if (arg === '--no-agents') agents = [];
    else if (arg === '--agents') {
      const parsed = parseAgentTargets(rest[++i]);
      if (parsed === undefined) {
        if (json) {
          return printJsonFailure(
            {
              code: 'invalid_agents',
              message: 'init: --agents must be codex, claude-code, all, or none',
              fix: 'Choose a supported coding-agent target.',
              next: 'noodle init --agents <codex|claude-code|all|none> --json',
            },
            EXIT.USAGE,
          );
        }
        console.error('init: --agents must be codex, claude-code, all, or none');
        return EXIT.USAGE;
      }
      agents = parsed;
    } else if (arg === '--force') force = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') continue;
    else if (arg === '--no-docs-mcp') docsMcp = false;
    else if (!dir && arg !== undefined && !arg.startsWith('--')) dir = arg;
  }
  try {
    const stages = BOOTSTRAP_STAGES.filter(
      (stage) =>
        stage === 'scaffold' ||
        (stage === 'context'
          ? agents.length > 0
          : stage === 'launch'
            ? launch !== undefined && launch !== 'none'
            : install),
    );
    const result = await bootstrapProject(
      {
        ...(dir !== undefined ? { dir } : {}),
        ...(template !== undefined ? { template } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(force ? { force } : {}),
        agentTargets: agents,
        ...(dryRun ? { dryRun } : {}),
        install,
        ...(launch !== undefined ? { launch } : {}),
        docsMcp,
        ...(packageManager ? { packageManager } : {}),
      },
      {
        env,
        interactive: !json && isInteractive(),
        chooseAgent: chooseBootstrapAgent,
        ...(configLocation !== undefined ? { configLocation } : {}),
        ...(!json
          ? {
              progress: (stage, status) => {
                if (status === 'running')
                  console.log(
                    stage === 'launch' && !stages.includes(stage)
                      ? 'Launching the explicitly selected coding agent…'
                      : `[${stages.indexOf(stage) + 1}/${stages.length}] ${stage}`,
                  );
              },
            }
          : {}),
      },
    );
    const agentReport = result.agents;
    const docsMcpReport = result.docsMcp;
    if (json) {
      if (result.setup.failed)
        return printJsonFailure(
          {
            code: 'bootstrap_failed',
            message: `Local setup stopped at ${result.setup.failed.stage}: ${result.setup.failed.code}.`,
            next: result.setup.resumeCommand,
            detail: { ...result, dryRun, ...(docsMcpReport ? { docsMcp: docsMcpReport } : {}) },
          },
          EXIT.FAILURE,
        );
      printJsonOk(
        {
          dryRun,
          dir: result.dir,
          files: result.files,
          ...(agentReport !== undefined ? { agents: agentReport } : {}),
          ...(docsMcpReport !== undefined ? { docsMcp: docsMcpReport } : {}),
          setup: result.setup,
          nextCommands: result.setup.nextSteps,
        },
        result.warnings,
      );
      return 0;
    }
    const verb = dryRun ? 'Would initialize' : 'Initialized';
    console.log(`${verb} Noodle project in ${result.dir}`);
    for (const file of result.files) {
      const note =
        file.action === 'skipped'
          ? `${file.path} (modified — pass --force to overwrite)`
          : file.path;
      console.log(`  ${file.action} ${note}`);
    }
    console.log(
      result.setup.ready
        ? 'Local synthetic behavior and types verified. Your customer backend and hosted deployment are not yet verified.'
        : 'Files prepared; local verification is not complete.',
    );
    if (result.setup.failed)
      console.error(`Setup stopped at ${result.setup.failed.stage}: ${result.setup.failed.code}.`);
    for (const warning of result.warnings ?? []) console.error(warning);
    for (const next of result.setup.nextSteps)
      console.log(`Next: ${next.command} — ${next.reason}`);
    if (result.setup.restartRequired)
      console.log(
        'Agent context changed: explicitly read AGENTS.md and project skills, or start a fresh coding-agent session.',
      );
    if (agentReport !== undefined) {
      for (const file of agentReport.files) console.log(`  agent ${file.action} ${file.path}`);
    }
    if (docsMcpReport !== undefined) {
      const verb = docsMcpReport.action.replace('would-', 'would ');
      console.log(`  docs  ${verb} ${docsMcpReport.name} .mcp.json`);
    }
    return result.setup.failed ? EXIT.FAILURE : EXIT.OK;
  } catch (error) {
    const message = (error as Error).message;
    if (json) {
      // The try covers init/agents/docs — only a non-empty-directory failure is `--force`-able. For any
      // other error, point at the generic recovery so an agent never blindly re-runs with --force.
      const isNonEmptyDir = message.toLowerCase().includes('not empty');
      // Machine-readable failure: emit the uniform envelope on stdout, never plain text.
      return printJsonFailure(
        {
          code: 'init_failed',
          message,
          fix: isNonEmptyDir
            ? 'The target directory is not empty; re-run with --force to overwrite.'
            : 'Resolve the reported problem and re-run.',
          next: isNonEmptyDir ? 'noodle init --force' : 'noodle doctor',
        },
        2,
      );
    }
    console.error(message);
    return 2;
  }
}

export async function runSetup(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  configLocation?: ConfigLocation,
): Promise<number> {
  let project = process.cwd();
  let write = false;
  let force = false;
  const json = rest.includes('--json');
  let agents: readonly AgentTarget[] = ['codex', 'claude-code'];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--project') project = rest[++i] ?? project;
    else if (arg === '--write') write = true;
    else if (arg === '--force') force = true;
    else if (arg === '--json') continue;
    else if (arg === '--no-agents') agents = [];
    else if (arg === '--agents') {
      const parsed = parseAgentTargets(rest[++i]);
      if (parsed === undefined) {
        if (json) {
          return printJsonFailure(
            {
              code: 'invalid_agents',
              message: 'setup: --agents must be codex, claude-code, all, or none',
              fix: 'Choose a supported coding-agent target.',
              next: 'noodle setup --agents <codex|claude-code|all|none> --json',
            },
            EXIT.USAGE,
          );
        }
        console.error('setup: --agents must be codex, claude-code, all, or none');
        return EXIT.USAGE;
      }
      agents = parsed;
    }
  }
  if (write && !existsSync(noodleProjectConfigPath(project))) {
    const resolved = readResolvedProjectConfig(project);
    const conventional = resolveConventionalEntrypoint(project);
    writeNoodleProjectConfig(project, {
      entrypoint:
        resolved.entrypoint ??
        (conventional !== undefined ? relativeEntrypoint(conventional, project) : 'server.ts'),
      ...(resolved.name !== undefined ? { name: resolved.name } : {}),
      ...(resolved.app !== undefined ? { app: resolved.app } : {}),
      ...(resolved.org !== undefined ? { org: resolved.org } : {}),
      ...(resolved.env !== undefined ? { env: resolved.env } : {}),
      ...(resolved.accessMode !== undefined ? { accessMode: resolved.accessMode } : {}),
      agents,
      ...(resolved.serviceUrl !== undefined ? { serviceUrl: resolved.serviceUrl } : {}),
    });
  }
  const report = await setupAgentsWithResolvedSkills(
    { agents, project, write, force, json },
    env,
    configLocation,
  );
  if (json) {
    printJsonOk(report);
    return 0;
  }
  console.log(write ? 'Noodle setup wrote project files.' : 'Dry run: Noodle setup.');
  if (!write) console.log('No files were written.');
  for (const file of report.files) console.log(`  ${file.action} ${file.path}`);
  if (!write) console.log('Next: noodle setup --write');
  return 0;
}

export function runLink(rest: readonly string[]): number {
  let entrypoint: string | undefined;
  let org: string | undefined;
  let app: string | undefined;
  let targetEnv: string | undefined;
  let serviceUrl: string | undefined;
  let accessMode: AccessMode | undefined;
  let save: 'local' | 'project' = 'local';
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--entrypoint') entrypoint = relativeEntrypoint(rest[++i] ?? 'server.ts');
    else if (arg === '--org') org = rest[++i];
    else if (arg === '--app') app = rest[++i];
    else if (arg === '--env') targetEnv = rest[++i];
    else if (arg === '--service') serviceUrl = rest[++i];
    else if (arg === '--save') {
      const value = rest[++i];
      if (value === 'local' || value === 'project') save = value;
      else if (value === undefined || value.startsWith('--')) {
        save = 'local';
        i--;
      } else {
        console.error('link: --save must be local or project');
        return 2;
      }
    } else if (arg === '--access') {
      const value = rest[++i];
      if (!isAccessMode(value)) {
        console.error('link: --access must be owner-only or org-members');
        return 2;
      }
      accessMode = value;
    }
  }
  if (org === undefined || app === undefined) {
    console.error('link: --org and --app are required');
    console.error('next: noodle link --org <org> --app <app>');
    return 2;
  }
  const link = writeProjectLink({
    org,
    app,
    ...(entrypoint !== undefined ? { entrypoint } : {}),
    ...(targetEnv !== undefined ? { env: targetEnv } : {}),
    ...(serviceUrl !== undefined ? { serviceUrl } : {}),
    ...(accessMode !== undefined ? { accessMode } : {}),
    save,
  });
  console.log(save === 'project' ? 'Saved noodle.json.' : 'Saved .noodle/project.json.');
  console.log(`  entrypoint: ${link.entrypoint}`);
  console.log(`  service:    ${link.serviceUrl}`);
  console.log(`  org:        ${link.org}`);
  console.log(`  app:        ${link.app}`);
  console.log(`  env:        ${link.env}`);
  console.log(`  access:     ${link.accessMode}`);
  return 0;
}

export function runDocs(rest: readonly string[]): number {
  const [action, ...tail] = rest;
  let format: string | undefined;
  let output: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (arg === '--format') format = tail[++i];
    else if (arg === '--output') output = tail[++i];
  }
  if (action !== 'export' || format !== 'llms') {
    console.error('docs: usage: noodle docs export --format llms [--output <file>]');
    return 2;
  }
  const content = llmsDocs();
  if (output !== undefined) {
    writeFileSync(output, content);
    console.log(output);
  } else {
    console.log(content);
  }
  return 0;
}

function llmsDocs(): string {
  return [
    '# Noodle Seed Platform LLM Context',
    '',
    'Noodle apps are declarative MCP servers authored with the Noodle CLI.',
    '',
    'Running the CLI: the blessed zero-install path is `npx @noodleseed/one@latest <command>` — it needs no',
    'global install. Requires Node.js 24+. For reproducible runs (CI, agents), pin the version, e.g.',
    '`npx @noodleseed/one@<version> <command>`. A global `npm install -g @noodleseed/one` also works.',
    '',
    'Core workflow:',
    '',
    '```sh',
    'noodle init',
    'noodle validate',
    'noodle doctor',
    'noodle dev',
    'noodle test',
    'noodle deploy',
    'noodle open',
    '```',
    '',
    '`noodle init` is safe to re-run: it creates missing scaffold files, leaves identical ones unchanged,',
    'and preserves files you have edited (pass `--force` to overwrite). Use `noodle init --dry-run --json`',
    'to inspect the reconcile plan without writing.',
    '',
    'Use test-driven development. Manage connector credentials with `noodle secrets set`; never place secret values in prompts, docs, generated files, or agent instructions. Hosted access is identity-only (`owner-only` or `org-members`); do not add caller-key mechanisms.',
    '',
    'Widget authoring:',
    '',
    '- Use `tool(...)` for model-visible tools that render MCP Apps widgets.',
    '- Use `tool(...)` for app-only UI helper tools; hosts use their app visibility metadata to hide them from the model while widget UI calls them through the normal `tools/call` path.',
    '- Author widget UI as React `view` entries with `generateHelpers<AppType>()`; raw `html` remains the explicit escape hatch.',
    '- Run `noodle devtools` for local widget preview and `noodle check --json` for fix-ready readiness checks.',
    '',
  ].join('\n');
}

/**
 * `noodle export manifest [server.ts] [--output <file>] [--connectors-output <file>] [--connectors <f>]`
 *
 * Compile the authored server **locally** (the same path `deploy`/`dev` use, via {@link readDeployInput})
 * and emit the portable manifest JSON — no service, no login, no account. This is the eject path: a Noodle
 * app is just your `server.ts` plus this portable, vendor-neutral manifest. Writes to files when
 * `--output`/`--connectors-output` are given, else stdout.
 */
export async function runExport(rest: readonly string[]): Promise<number> {
  const [kind, ...tail] = rest;
  if (kind === 'plugin') {
    const [target, ...targetRest] = tail;
    if (target === 'openai') return runOpenAi(targetRest, compileLocal, resolveLocalEntrypoint);
    if (target === 'claude') return runClaude(targetRest, compileLocal, resolveLocalEntrypoint);
    const json = tail.includes('--json');
    const message = 'export plugin requires the openai or claude target';
    if (json) {
      return printJsonFailure(
        {
          code: 'unsupported_plugin_target',
          message,
          fix: 'Choose the OpenAI or Claude plugin target.',
          next: 'noodle export --help',
        },
        EXIT.USAGE,
      );
    }
    console.error(message);
    return EXIT.USAGE;
  }
  if (kind === 'connector') {
    const [target, ...targetRest] = tail;
    if (target === 'claude') {
      return runAnthropicConnector(targetRest, compileLocal, resolveLocalEntrypoint);
    }
    const json = tail.includes('--json');
    const message = 'export connector requires the claude target';
    if (json) {
      return printJsonFailure(
        {
          code: 'unsupported_connector_target',
          message,
          fix: 'Choose the Claude Connector Directory target.',
          next: 'noodle export connector claude --help',
        },
        EXIT.USAGE,
      );
    }
    console.error(message);
    return EXIT.USAGE;
  }
  if (kind !== 'manifest') {
    console.error(
      'export: use noodle export manifest, noodle export plugin <openai|claude>, or noodle export connector claude',
    );
    return EXIT.USAGE;
  }
  let entrypoint: string | undefined;
  let output: string | undefined;
  let connectorsOutput: string | undefined;
  let connectorsPath: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (arg === '--output' || arg === '-o') output = tail[++i];
    else if (arg === '--connectors-output') connectorsOutput = tail[++i];
    else if (arg === '--connectors') connectorsPath = tail[++i];
    else if (!entrypoint && arg !== undefined && !arg.startsWith('--')) entrypoint = arg;
  }
  const manifestPath = entrypoint ?? resolveLocalEntrypoint();
  if (!manifestPath) return missingProjectEntrypoint('export manifest');

  let manifestJson: string;
  let connectorsJson: string | undefined;
  try {
    const input = await readDeployInput(manifestPath);
    // Re-indent for a human- and diff-friendly portable artifact (input.manifest is a compact JSON string).
    manifestJson = `${JSON.stringify(JSON.parse(input.manifest), null, 2)}\n`;
    const rawConnectors =
      connectorsPath !== undefined ? readFileSync(connectorsPath, 'utf8') : input.connectors;
    if (rawConnectors !== undefined && rawConnectors.trim() !== '') {
      connectorsJson = `${JSON.stringify(JSON.parse(rawConnectors), null, 2)}\n`;
    }
  } catch (error) {
    printRecovery({
      command: 'export manifest',
      cause: errorMessage(error),
      fix: 'Fix the authored server so it compiles, then export again.',
      next: 'noodle validate',
    });
    return 1;
  }

  if (output !== undefined) {
    writeFileSync(output, manifestJson);
    console.log(`Wrote portable manifest to ${output}`);
  } else {
    // cli-output-drift-allow: human-only raw manifest export; this command has no --json mode.
    process.stdout.write(manifestJson);
  }
  if (connectorsJson !== undefined) {
    if (connectorsOutput !== undefined) {
      writeFileSync(connectorsOutput, connectorsJson);
      console.log(`Wrote connector catalog to ${connectorsOutput}`);
    } else if (output !== undefined) {
      console.log(
        'Note: this app has a connector catalog; pass --connectors-output to export it too.',
      );
    }
  }
  return 0;
}

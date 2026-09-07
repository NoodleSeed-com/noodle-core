import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  AGENT_KIT_VERSION,
  type AgentTarget,
  parseAgentTargets,
  reconcileManagedBlock,
  renderAgentFiles,
  type SkillRegistry,
} from '@noodle-borg/agent-kit';
import {
  commandOnPath,
  displayAgentName,
  isSkillsUpdateContext,
  pluginRequiredAgentKitVersion,
  resolveAgentProjectMetadata,
} from './agent-command-context.js';
import {
  compileProjectProductSkill,
  type ProductSkillSetupReport,
  setupProjectProductSkill,
} from './agent-product-skill.js';
import { nextAgentSetupCommand, productSkillRecoveryNext } from './agent-product-skill-output.js';
import { assertManagedSkillFilesSafe, reconcileManagedSkillFiles } from './agent-skills-state.js';
import { runAgentDoctor } from './agents-doctor.js';
import { EXIT, printJsonFailure, printJsonOk } from './commands/output.js';
import { type ConfigLocation, configDir, readConfig } from './config.js';
import { readResolvedProjectConfig } from './project.js';
import { fetchLatestAgentKitVersion, resolveAgentKit } from './skills-update.js';

export { staleAgentContextError } from './agents-doctor.js';

type AgentClientArg = AgentTarget | 'all' | 'none';

interface AgentArgs {
  readonly action: string | undefined;
  /** undefined = no --agents flag; the project's noodle.json `agents` list (else both) is the default. */
  readonly agents: readonly AgentTarget[] | undefined;
  readonly project: string;
  readonly write: boolean;
  readonly force: boolean;
  readonly regenerateAppSkill: boolean;
  readonly replaceModifiedAppSkill: boolean;
  readonly json: boolean;
  readonly refresh: boolean;
}

type ResolvedAgentArgs = AgentArgs & { readonly agents: readonly AgentTarget[] };

export type AgentSetupInput = Omit<
  ResolvedAgentArgs,
  'action' | 'refresh' | 'regenerateAppSkill' | 'replaceModifiedAppSkill'
> & {
  readonly skillsOverride?: ResolvedSkillsSnapshot;
  readonly registry?: SkillRegistry;
};

interface ResolvedSkillsSnapshot {
  readonly packageVersion: string;
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
    readonly target: AgentTarget;
    readonly skill: string;
    readonly skillVersion: string;
  }[];
}

interface AgentFileAction {
  readonly path: string;
  readonly target: AgentTarget;
  readonly action: 'created' | 'unchanged' | 'updated' | 'skipped' | 'overwritten' | 'removed';
  readonly reason?: string;
}

export interface AgentSetupReport {
  readonly ok: boolean;
  readonly dryRun: boolean;
  readonly project: string;
  readonly targets: readonly AgentTarget[];
  readonly files: readonly AgentFileAction[];
  readonly restartHints: readonly string[];
  readonly productSkill?: ProductSkillSetupReport;
}

export async function runAgents(
  rest: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  configLocation?: ConfigLocation,
): Promise<number> {
  const args = parseAgentArgs(rest);
  if (args === undefined) return 2;
  const resolved: ResolvedAgentArgs = {
    ...args,
    agents: args.agents ??
      readResolvedProjectConfig(args.project).agents ?? ['codex', 'claude-code'],
  };
  if (args.action === 'setup' || args.action === 'context')
    return runAgentSetup(resolved, env, configLocation);
  if (args.action === 'doctor') return runAgentDoctor(resolved, env, configLocation);
  if (args.json) {
    return printJsonFailure(
      {
        code: 'invalid_action',
        message: 'agents: expected setup, context, or doctor',
        fix: 'Choose a supported agents action.',
        next: 'noodle agents --help',
      },
      EXIT.USAGE,
    );
  }
  console.error('agents: expected setup, context, or doctor');
  return EXIT.USAGE;
}

export function setupAgents(args: AgentSetupInput): AgentSetupReport {
  const planned = renderAgentFiles({
    targets: args.agents,
    ...(args.registry !== undefined ? { registry: args.registry } : {}),
    project: resolveAgentProjectMetadata(args.project),
  });
  // A registry-fresh snapshot replaces the bundled generated tree as one complete unit. The managed
  // host block stays bundled because it is project-specific.
  const generatedFiles =
    args.skillsOverride === undefined
      ? planned.filter((file) => file.mode === 'generated-file')
      : args.skillsOverride.files.filter((file) => args.agents.includes(file.target));
  validateResolvedSkillsSnapshot(args.agents, generatedFiles);
  if (args.write) {
    for (const target of args.agents) {
      assertManagedSkillFilesSafe({
        project: args.project,
        target,
        files: generatedFiles.filter((file) => file.target === target),
      });
    }
  }
  const files: AgentFileAction[] = [];
  for (const file of planned.filter((candidate) => candidate.mode === 'managed-block')) {
    const full = join(args.project, file.path);
    const existing = existsSync(full) ? readFileSync(full, 'utf8') : undefined;
    if (!args.write) {
      files.push({
        path: file.path,
        target: file.target,
        action:
          existing === undefined ? 'created' : existing === file.content ? 'unchanged' : 'updated',
      });
      continue;
    }
    const result = reconcileManagedBlock({
      ...(existing !== undefined ? { existing } : {}),
      block: file.content,
      force: args.force,
    });
    if (result.action !== 'unchanged' && result.action !== 'skipped') {
      if (args.write) {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, result.content);
      }
    }
    files.push({
      path: file.path,
      target: file.target,
      action: result.action,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    });
  }
  for (const target of args.agents) {
    const generated = generatedFiles.filter((file) => file.target === target);
    files.push(
      ...reconcileManagedSkillFiles({
        project: args.project,
        target,
        packageVersion: args.skillsOverride?.packageVersion ?? AGENT_KIT_VERSION,
        files: generated.map((file) => ({
          path: file.path,
          content: file.content,
          skill: file.skill ?? failMissingSkillIdentity(file.path),
          skillVersion: file.skillVersion ?? failMissingSkillIdentity(file.path),
        })),
        write: args.write,
      }),
    );
  }
  return {
    ok: true,
    dryRun: !args.write,
    project: args.project,
    targets: args.agents,
    files,
    restartHints:
      args.agents.length > 0
        ? ['Restart or reload your coding agent so it picks up new skills.']
        : [],
  };
}

function validateResolvedSkillsSnapshot(
  targets: readonly AgentTarget[],
  files: readonly {
    readonly path: string;
    readonly target: AgentTarget;
    readonly skill?: string;
  }[],
): void {
  const paths = new Set<string>();
  for (const file of files) {
    const expectedRoot = `${file.target === 'codex' ? '.agents' : '.claude'}/skills/${file.skill ?? ''}/`;
    if (
      file.skill === undefined ||
      !file.path.startsWith(expectedRoot) ||
      file.path.includes('\\') ||
      file.path
        .split('/')
        .some((segment) => segment === '' || segment === '.' || segment === '..') ||
      paths.has(file.path)
    ) {
      throw new Error(`resolved skill snapshot has invalid or duplicate path: ${file.path}`);
    }
    paths.add(file.path);
  }
  for (const target of targets) {
    const targetFiles = files.filter((file) => file.target === target);
    if (targetFiles.length === 0) throw new Error(`resolved skill snapshot is missing ${target}`);
    const skills = new Set(targetFiles.map((file) => file.skill));
    for (const skill of skills) {
      if (
        skill === undefined ||
        !targetFiles.some(
          (file) => file.skill === skill && file.path.endsWith(`/skills/${skill}/SKILL.md`),
        )
      ) {
        throw new Error(
          `resolved skill snapshot is missing SKILL.md for ${target}/${skill ?? '?'}`,
        );
      }
    }
  }
}

function failMissingSkillIdentity(path: string): never {
  throw new Error(`generated skill file is missing registry identity: ${path}`);
}

/** Resolve the active Agent Kit profile before rendering any project agent files. */
export async function setupAgentsWithResolvedSkills(
  args: Omit<AgentSetupInput, 'skillsOverride'> & { readonly refresh?: boolean },
  env: NodeJS.ProcessEnv = process.env,
  configLocation?: ConfigLocation,
): Promise<AgentSetupReport> {
  // Interactive writes may fetch registry-latest, while plugin mode resolves the exact compatibility pin.
  // Dry runs never fetch; unresolved remote updates fall back to the bundled snapshot.
  let override: ResolvedSkillsSnapshot | undefined;
  const pluginRequiredVersion = pluginRequiredAgentKitVersion(env);
  if (
    args.write &&
    (args.refresh === true || pluginRequiredVersion !== undefined || isSkillsUpdateContext(env))
  ) {
    override = await resolveSkillsOverride(
      args.refresh === true,
      configLocation,
      pluginRequiredVersion,
    );
  }
  return setupAgents({
    ...args,
    ...(override !== undefined ? { skillsOverride: override } : {}),
  });
}

async function runAgentSetup(
  args: ResolvedAgentArgs,
  env: NodeJS.ProcessEnv,
  configLocation?: ConfigLocation,
): Promise<number> {
  const report = await setupAgentsWithResolvedSkills(
    {
      ...args,
      refresh: args.refresh,
    },
    env,
    configLocation,
  );
  const productSkill = setupProjectProductSkill({
    project: args.project,
    targets: args.agents,
    write: args.write,
    regenerateAppSkill: args.regenerateAppSkill,
    replaceModifiedAppSkill: args.replaceModifiedAppSkill,
    compilation: await compileProjectProductSkill(args.project),
  });
  const combined: AgentSetupReport =
    productSkill === undefined
      ? report
      : { ...report, ok: report.ok && productSkill.ok, productSkill };
  if (args.json) {
    if (combined.ok) {
      printJsonOk(combined);
      return 0;
    }
    const issue = productSkill?.issues[0];
    return printJsonFailure(
      {
        code: issue?.code ?? 'agent_skill_stale',
        message: issue?.message ?? 'app product skill could not be installed safely',
        next: productSkillRecoveryNext(issue),
        detail: { report: combined },
      },
      1,
    );
  }
  console.log(
    args.write ? 'Noodle agent setup wrote project files.' : 'Dry run: Noodle agent setup.',
  );
  console.log(`Project: ${combined.project}`);
  if (args.agents.length === 0) {
    console.log('No agent targets configured (noodle.json "agents": []) — nothing to generate.');
  }
  if (!args.write) console.log('No files were written.');
  for (const target of args.agents) {
    const installed = commandOnPath(target === 'codex' ? 'codex' : 'claude', env);
    console.log(
      `${displayAgentName(target)}: ${installed ? 'detected on PATH' : 'not detected on PATH'}`,
    );
  }
  for (const file of combined.files) {
    const suffix = file.reason !== undefined ? ` (${file.reason})` : '';
    console.log(`  ${file.action} ${file.path}${suffix}`);
  }
  if (combined.productSkill !== undefined) {
    const app = combined.productSkill.app;
    console.log(
      app === undefined
        ? 'App product skill: unavailable'
        : `App product skill: ${app.name} (${app.skillSlug})`,
    );
    for (const target of combined.productSkill.targets) {
      const pending = target.requiresRegeneration && !target.applied ? ' (preview only)' : '';
      console.log(
        `  ${displayAgentName(target.target)}: ${target.status}; state ${target.stateAction}${pending}`,
      );
      for (const file of target.files) {
        const reason = file.reason === undefined ? '' : ` (${file.reason})`;
        console.log(`    ${file.action} ${file.path}${reason}`);
      }
    }
    for (const issue of combined.productSkill.issues) {
      console.log(`  ${issue.code}: ${issue.message}`);
    }
  }
  const next = nextAgentSetupCommand(args, combined.productSkill);
  if (next !== undefined) console.log(`Next: ${next}`);
  for (const hint of combined.restartHints) console.log(`Hint: ${hint}`);
  return combined.ok ? 0 : 1;
}

async function resolveSkillsOverride(
  refresh: boolean,
  configLocation: ConfigLocation | undefined,
  pluginRequiredVersion: string | undefined,
): Promise<ResolvedSkillsSnapshot | undefined> {
  const cacheDir = join(configDir(configLocation), 'cache', 'agent-kit');
  const registryVersion =
    pluginRequiredVersion ??
    readConfig(configLocation).updateCheck?.skillsLatestVersion ??
    (await fetchLatestAgentKitVersion());
  const result = await resolveAgentKit({
    registryVersion,
    cacheDir,
    ...(pluginRequiredVersion !== undefined && pluginRequiredVersion !== AGENT_KIT_VERSION
      ? { pinned: true }
      : {}),
    ...(refresh ? { force: true } : {}),
  });
  if (result.status !== 'ready' || result.kit === undefined) return undefined;
  const files: ResolvedSkillsSnapshot['files'][number][] = [];
  for (const file of result.kit.manifest.files) {
    const content = result.kit.files.get(file.path);
    if (content === undefined) return undefined;
    files.push({
      path: file.installedPath,
      content,
      target: file.agentTarget,
      skill: file.skill,
      skillVersion: file.skillVersion,
    });
  }
  return { packageVersion: result.kit.version, files };
}

function parseAgentArgs(rest: readonly string[]): AgentArgs | undefined {
  const [action, ...tail] = rest;
  let agents: readonly AgentTarget[] | undefined;
  let project = process.cwd();
  let write = false;
  let force = false;
  let regenerateAppSkill = false;
  let replaceModifiedAppSkill = false;
  const json = rest.includes('--json');
  let refresh = false;
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (arg === '--agents' || arg === '--client') {
      const raw = tail[++i];
      const parsed = parseClientArg(raw);
      if (parsed === undefined) {
        if (json) {
          printJsonFailure(
            {
              code: 'invalid_agents',
              message: '--agents must be codex, claude-code, all, or none',
              fix: 'Choose a supported coding-agent target.',
              next: 'noodle agents setup --agents <codex|claude-code|all|none> --json',
            },
            EXIT.USAGE,
          );
          return undefined;
        }
        console.error('--agents must be codex, claude-code, all, or none');
        return undefined;
      }
      agents = parsed;
    } else if (arg === '--project') {
      project = resolve(tail[++i] ?? '.');
    } else if (arg === '--write') {
      write = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--regenerate-app-skill') {
      regenerateAppSkill = true;
    } else if (arg === '--replace-modified-app-skill') {
      replaceModifiedAppSkill = true;
    } else if (arg === '--refresh') {
      refresh = true;
    }
  }
  if (replaceModifiedAppSkill && !regenerateAppSkill) {
    if (json) {
      printJsonFailure(
        {
          code: 'invalid_flag_combination',
          message: '--replace-modified-app-skill requires --regenerate-app-skill',
          fix: 'Preview explicit app-skill regeneration before replacing previously owned bytes.',
          next: 'noodle agents setup --regenerate-app-skill --replace-modified-app-skill --json',
        },
        EXIT.USAGE,
      );
    } else {
      console.error('--replace-modified-app-skill requires --regenerate-app-skill');
    }
    return undefined;
  }
  return {
    action,
    agents,
    project,
    write,
    force,
    regenerateAppSkill,
    replaceModifiedAppSkill,
    json,
    refresh,
  };
}

function parseClientArg(value: string | undefined): readonly AgentTarget[] | undefined {
  return parseAgentTargets(value as AgentClientArg | undefined);
}

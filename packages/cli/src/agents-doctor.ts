import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENT_KIT_VERSION,
  type AgentTarget,
  contentSha256,
  reconcileManagedBlock,
  renderAgentFiles,
} from '@noodle-borg/agent-kit';
import {
  commandOnPath,
  displayAgentName,
  isSkillsUpdateContext,
  pluginRequiredAgentKitVersion,
  resolveAgentProjectMetadata,
} from './agent-command-context.js';
import { type AgentProductSkillCode, compileProjectProductSkill } from './agent-product-skill.js';
import { doctorProjectProductSkill } from './agent-product-skill-doctor.js';
import { readManagedSkillState } from './agent-skills-state.js';
import { type JsonError, printJsonFailure, printJsonOk } from './commands/output.js';
import { type ConfigLocation, configDir } from './config.js';
import { fetchLatestAgentKitVersion, loadCachedAgentKit, skillStaleness } from './skills-update.js';

export interface AgentDoctorCheck {
  readonly name: string;
  readonly level: string;
  readonly message: string;
  readonly code?: AgentProductSkillCode;
}

interface DoctorAgentFile {
  readonly path: string;
  readonly mode: 'managed-block' | 'generated-file';
  readonly expectedContent?: string;
  readonly skill?: string;
  readonly skillVersion?: string;
  readonly expectedSha256?: string;
}

export function staleAgentContextError(checks: readonly AgentDoctorCheck[]): JsonError {
  const nextCommands = agentDoctorNextCommands(checks);
  return {
    code: 'agent_context_stale',
    message: 'agent context is stale or missing',
    next: checks.some((check) => check.code !== undefined)
      ? 'noodle agents setup'
      : 'noodle agents setup --write',
    detail: { checks, ...(nextCommands.length > 0 ? { nextCommands } : {}) },
  };
}

export async function runAgentDoctor(
  args: {
    readonly agents: readonly AgentTarget[];
    readonly project: string;
    readonly json: boolean;
  },
  env: NodeJS.ProcessEnv,
  configLocation?: ConfigLocation,
): Promise<number> {
  const pluginRequiredVersion = pluginRequiredAgentKitVersion(env);
  const expectedSkillsVersion =
    pluginRequiredVersion ??
    (isSkillsUpdateContext(env) ? await fetchLatestAgentKitVersion() : undefined);
  const pluginPinnedKit =
    pluginRequiredVersion !== undefined && pluginRequiredVersion !== AGENT_KIT_VERSION
      ? loadCachedAgentKit({
          cacheDir: join(configDir(configLocation), 'cache', 'agent-kit'),
          version: pluginRequiredVersion,
        })
      : undefined;
  const projectMetadata = resolveAgentProjectMetadata(args.project);
  const workflowChecks = args.agents.flatMap((target) => {
    const bundled = renderAgentFiles({ targets: [target], project: projectMetadata });
    const state = readManagedSkillState(args.project, target);
    const useOwnedSnapshot =
      pluginPinnedKit === undefined &&
      state !== undefined &&
      state.packageVersion !== AGENT_KIT_VERSION;
    const generatedBase: readonly DoctorAgentFile[] =
      pluginPinnedKit !== undefined
        ? pluginPinnedKit.manifest.files
            .filter((file) => file.agentTarget === target)
            .map((file) => ({
              path: file.installedPath,
              mode: 'generated-file' as const,
              skill: file.skill,
              skillVersion: file.skillVersion,
              expectedSha256: file.sha256,
            }))
        : useOwnedSnapshot
          ? state.files.map((file) => ({
              path: file.path,
              mode: 'generated-file' as const,
              skill: file.skill,
              skillVersion: file.skillVersion,
              expectedSha256: file.sha256,
            }))
          : bundled
              .filter((file) => file.mode === 'generated-file')
              .map((file) => ({
                path: file.path,
                mode: file.mode,
                skill: file.skill ?? failMissingSkillIdentity(file.path),
                skillVersion: file.skillVersion ?? failMissingSkillIdentity(file.path),
                expectedSha256: contentSha256(file.content),
              }));
    const generated: readonly DoctorAgentFile[] =
      pluginPinnedKit === undefined && state !== undefined && !useOwnedSnapshot
        ? [
            ...generatedBase,
            ...state.files
              .filter((file) => !generatedBase.some((candidate) => candidate.path === file.path))
              .map((file) => ({
                path: file.path,
                mode: 'generated-file' as const,
                skill: file.skill,
                skillVersion: file.skillVersion,
                expectedSha256: file.sha256,
              })),
          ]
        : generatedBase;
    const files: readonly DoctorAgentFile[] = [
      ...bundled
        .filter((file) => file.mode === 'managed-block')
        .map((file) => ({
          path: file.path,
          mode: file.mode,
          expectedContent: file.content,
        })),
      ...generated,
    ];
    const referenceBaselineAvailable =
      pluginRequiredVersion === undefined ||
      pluginRequiredVersion === AGENT_KIT_VERSION ||
      pluginPinnedKit !== undefined;
    return [
      {
        name: `${displayAgentName(target)} binary`,
        level: commandOnPath(target === 'codex' ? 'codex' : 'claude', env) ? 'PASS' : 'WARN',
        message: target === 'codex' ? 'codex' : 'claude',
      },
      ...files.map((file) =>
        inspectWorkflowFile({
          project: args.project,
          target,
          file,
          pluginRequiredVersion,
          expectedSkillsVersion,
          referenceBaselineAvailable,
        }),
      ),
    ];
  });
  const checks: readonly AgentDoctorCheck[] = [
    ...workflowChecks,
    ...doctorProjectProductSkill({
      project: args.project,
      targets: args.agents,
      compilation: await compileProjectProductSkill(args.project),
    }),
  ];
  const ok = checks.every((check) => check.level !== 'FAIL');
  const nextCommands = agentDoctorNextCommands(checks);
  if (args.json) {
    if (ok) {
      const stale = checks.some((check) => check.level === 'WARN');
      printJsonOk({
        checks,
        restartRequired: false,
        stale,
        ...(nextCommands.length > 0 ? { nextCommands } : {}),
      });
      return 0;
    }
    return printJsonFailure(staleAgentContextError(checks), 1);
  }
  for (const check of checks) console.log(`${check.level} ${check.name}: ${check.message}`);
  for (const next of nextCommands) console.log(`Next: ${next.command} — ${next.reason}`);
  return ok ? 0 : 1;
}

function agentDoctorNextCommands(checks: readonly AgentDoctorCheck[]): readonly {
  readonly command: string;
  readonly reason: string;
}[] {
  const commands: { command: string; reason: string }[] = [];
  if (checks.some((check) => check.level !== 'PASS' && check.code !== undefined)) {
    commands.push({
      command: 'noodle agents setup',
      reason: 'preview app product-skill recovery without writing',
    });
  }
  if (checks.some((check) => check.level !== 'PASS' && check.code === undefined)) {
    commands.push({
      command: 'noodle agents setup --write',
      reason: 'refresh stale or missing Noodle-owned agent context',
    });
  }
  return commands;
}

function inspectWorkflowFile(input: {
  readonly project: string;
  readonly target: AgentTarget;
  readonly file: DoctorAgentFile;
  readonly pluginRequiredVersion: string | undefined;
  readonly expectedSkillsVersion: string | undefined;
  readonly referenceBaselineAvailable: boolean;
}): AgentDoctorCheck {
  const path = join(input.project, input.file.path);
  if (!existsSync(path)) {
    return {
      name: input.file.path,
      level: 'WARN',
      message: 'run noodle agents setup --write',
    };
  }
  if (input.file.mode === 'managed-block' && input.file.expectedContent !== undefined) {
    const reconciliation = reconcileManagedBlock({
      existing: readFileSync(path, 'utf8'),
      block: input.file.expectedContent.trimEnd(),
    });
    if (reconciliation.action !== 'unchanged') {
      return {
        name: input.file.path,
        level: 'WARN',
        message: 'modified or stale; run noodle agents setup --write',
      };
    }
  }
  const skillVersion =
    input.file.mode === 'generated-file' && input.file.skill !== undefined
      ? readInstalledSkillVersion(
          join(
            input.project,
            `${input.target === 'codex' ? '.agents' : '.claude'}/skills/${input.file.skill}/SKILL.md`,
          ),
        )
      : undefined;
  if (input.file.mode === 'generated-file' && input.file.path.endsWith('/SKILL.md')) {
    const comparisonVersion = input.pluginRequiredVersion ?? input.expectedSkillsVersion;
    const pluginVersionMismatch =
      input.pluginRequiredVersion !== undefined && skillVersion !== input.pluginRequiredVersion;
    const staleness = pluginVersionMismatch
      ? 'stale'
      : skillStaleness(skillVersion, comparisonVersion);
    const expectedVersionLabel =
      input.pluginRequiredVersion !== undefined ? 'plugin-required' : 'registry';
    if (staleness !== 'stale' && input.file.expectedSha256 !== undefined) {
      const current = contentSha256(readFileSync(path, 'utf8')) === input.file.expectedSha256;
      if (!current) {
        return {
          name: input.file.path,
          level: 'WARN',
          message: 'modified; run noodle agents setup --write',
        };
      }
    }
    return {
      name: input.file.path,
      level: staleness === 'stale' ? 'WARN' : 'PASS',
      message:
        staleness === 'stale'
          ? pluginVersionMismatch
            ? `installed v${skillVersion ?? '?'} does not match ${expectedVersionLabel} v${comparisonVersion}`
            : `installed v${skillVersion ?? '?'} is older than ${expectedVersionLabel} v${comparisonVersion}`
          : staleness === 'current'
            ? 'current'
            : 'present',
    };
  }
  if (
    input.file.mode === 'generated-file' &&
    !input.file.path.endsWith('/SKILL.md') &&
    input.pluginRequiredVersion !== undefined &&
    !input.referenceBaselineAvailable &&
    skillVersion === input.pluginRequiredVersion
  ) {
    return {
      name: input.file.path,
      level: 'WARN',
      message: `plugin-required v${input.pluginRequiredVersion} cache unavailable; run noodle agents setup --write`,
    };
  }
  if (
    input.file.mode === 'generated-file' &&
    skillVersion === input.file.skillVersion &&
    !input.file.path.endsWith('/SKILL.md')
  ) {
    if (!input.referenceBaselineAvailable) {
      return {
        name: input.file.path,
        level: 'WARN',
        message: `plugin-required v${input.pluginRequiredVersion} cache unavailable; run noodle agents setup --write`,
      };
    }
    const current =
      input.file.expectedSha256 !== undefined &&
      contentSha256(readFileSync(path, 'utf8')) === input.file.expectedSha256;
    return {
      name: input.file.path,
      level: current ? 'PASS' : 'WARN',
      message: current ? 'current' : 'modified; run noodle agents setup --write',
    };
  }
  return { name: input.file.path, level: 'PASS', message: 'present' };
}

function readInstalledSkillVersion(path: string): string | undefined {
  try {
    const content = readFileSync(path, 'utf8');
    const metadata = /^<!-- noodle-skill version:([^ ]+) hash:[a-f0-9]{16} -->$/m.exec(content);
    if (metadata?.[1]) return metadata[1];
    const lines = content.split('\n');
    const close = lines.indexOf('---', 1);
    if (close < 0) return undefined;
    const frontmatter = lines.slice(1, close).join('\n');
    return /^version:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function failMissingSkillIdentity(path: string): never {
  throw new Error(`generated skill file is missing registry identity: ${path}`);
}

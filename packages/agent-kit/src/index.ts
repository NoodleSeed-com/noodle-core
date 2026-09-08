import { createHash } from 'node:crypto';
import { BEHAVIOR_SKILLS, renderBehaviorSkillBody } from './behavior-skills.js';
import { BUNDLED_EXAMPLE_FILES } from './generated/example-files.js';
import { EXECUTING_NOODLE_PLANS_SKILL } from './plan-execution-skill.js';
import { SKILL_REFERENCES } from './skill-content.js';
import {
  type AgentTarget,
  defineSkillRegistry,
  renderRegisteredSkillFiles,
  type SkillRegistry,
} from './skill-registry.js';
import { SKILL_DESCRIPTION, skillRouterBody } from './skill-router.js';
import { AGENT_KIT_VERSION } from './version.js';

export type * from '@noodle-borg/agent-packaging';
export { HOST_PACKAGING_LIMITS, packageHostTarget } from '@noodle-borg/agent-packaging';
export * from '@noodle-borg/plugin-distribution';
export * from './behavior-skills.js';
export * from './plan-execution-skill.js';
export * from './plugin-compatibility.js';
export * from './plugin-copilot-bundle.js';
export * from './plugin-launcher.js';
export * from './plugin-submission.js';
export * from './product-skill-ownership.js';
export * from './product-skill-renderer.js';
export * from './skill-registry.js';
export { AGENT_KIT_VERSION } from './version.js';
export { NOODLE_WORDMARK } from './welcome-wordmark.js';

export const MANAGED_BEGIN = '<!-- BEGIN NOODLE AGENT CONTEXT -->';
export const MANAGED_END = '<!-- END NOODLE AGENT CONTEXT -->';

export type AgentTargetSelection = AgentTarget | 'all' | 'none';

export interface AgentProjectMetadata {
  readonly name?: string;
  readonly entrypoint?: string;
  readonly env?: string;
  readonly accessMode?: string;
  readonly template?: string;
  readonly org?: string;
  readonly app?: string;
}

export interface PlannedAgentFile {
  readonly target: AgentTarget;
  readonly path: string;
  readonly content: string;
  readonly mode: 'managed-block' | 'generated-file';
  readonly skill?: string;
  readonly skillVersion?: string;
}

export interface PublishableSkillFile {
  readonly path: string;
  readonly content: string;
  readonly agentTarget: AgentTarget;
  readonly skill: string;
  readonly skillVersion: string;
}

/** Correspondence between a publishable skill file and where it installs, per target. */
export interface SkillFileMapping {
  readonly publishPath: string;
  readonly installedPath: string;
  readonly agentTarget: AgentTarget;
  readonly skill: string;
  readonly skillVersion: string;
}

export interface AgentKitManifestFile {
  readonly path: string;
  readonly installedPath: string;
  readonly sha256: string;
  readonly agentTarget: AgentTarget;
  readonly skill: string;
  readonly skillVersion: string;
}

export interface AgentKitManifest {
  readonly schemaVersion: 2;
  readonly packageVersion: string;
  readonly files: readonly AgentKitManifestFile[];
}

export interface ManagedBlockResult {
  readonly content: string;
  readonly action: 'created' | 'unchanged' | 'updated' | 'skipped' | 'overwritten';
  readonly reason?: 'user-edited-managed-block' | 'duplicate-managed-blocks';
}

const TARGETS: readonly AgentTarget[] = ['codex', 'claude-code'];

/** Managed-block host file, per target. */
const MANAGED_FILE_BY_TARGET: Record<AgentTarget, string> = {
  codex: 'AGENTS.md',
  'claude-code': 'CLAUDE.md',
};

const SKILL_REFERENCE_BY_PATH = new Map(
  SKILL_REFERENCES.map((reference) => [reference.relPath, reference] as const),
);

function behaviorSkillReferenceFiles(skill: (typeof BEHAVIOR_SKILLS)[number]) {
  return [skill.primaryReference, ...skill.supportingReferences].map((path) => {
    const reference = SKILL_REFERENCE_BY_PATH.get(path);
    if (reference === undefined) throw new Error(`missing behavior skill reference: ${path}`);
    return {
      relPath: reference.relPath,
      render: () => reference.render(),
    };
  });
}

export const SKILL_REGISTRY = defineSkillRegistry([
  {
    name: 'noodle-seed',
    description: SKILL_DESCRIPTION,
    version: AGENT_KIT_VERSION,
    supportedHosts: TARGETS,
    publishAtTargetRoot: true,
    renderBody: skillRouterBody,
    files: [
      ...SKILL_REFERENCES.map((reference) => ({
        relPath: reference.relPath,
        render: () => reference.render(),
      })),
      ...BUNDLED_EXAMPLE_FILES.map((file) => ({
        relPath: file.relPath,
        render: () => file.content,
      })),
    ],
  },
  ...BEHAVIOR_SKILLS.map((skill) => ({
    name: skill.name,
    description: skill.description,
    version: AGENT_KIT_VERSION,
    supportedHosts: TARGETS,
    renderBody: (target: AgentTarget) => renderBehaviorSkillBody(skill, target),
    files: behaviorSkillReferenceFiles(skill),
  })),
  { ...EXECUTING_NOODLE_PLANS_SKILL, version: AGENT_KIT_VERSION },
]);

export function parseAgentTargets(value: string | undefined): readonly AgentTarget[] | undefined {
  if (value === undefined || value === 'all') return TARGETS;
  if (value === 'none') return [];
  if (value === 'codex') return ['codex'];
  if (value === 'claude-code') return ['claude-code'];
  return undefined;
}

export function renderAgentFiles(input: {
  readonly targets?: readonly AgentTarget[];
  readonly project?: AgentProjectMetadata;
  readonly registry?: SkillRegistry;
}): readonly PlannedAgentFile[] {
  const targets = input.targets ?? TARGETS;
  const files: PlannedAgentFile[] = [];
  for (const target of targets) {
    files.push({
      target,
      path: MANAGED_FILE_BY_TARGET[target],
      mode: 'managed-block',
      content: renderManagedBlock({
        target,
        ...(input.project !== undefined ? { project: input.project } : {}),
      }),
    });
    for (const file of renderRegisteredSkillFiles(input.registry ?? SKILL_REGISTRY, target)) {
      files.push({
        target,
        path: file.installedPath,
        mode: 'generated-file',
        content: file.content,
        skill: file.skill,
        skillVersion: file.skillVersion,
      });
    }
  }
  return files;
}

export function renderManagedBlock(input: {
  readonly target: AgentTarget;
  readonly project?: AgentProjectMetadata;
}): string {
  const body = [
    '# Noodle Seed Project Context',
    '',
    `Agent target: ${input.target === 'codex' ? 'Codex' : 'Claude Code'}.`,
    '',
    'Build this project as a Noodle Seed MCP server or app authored in TypeScript. Every `--json` command uses the canonical envelope on stdout and keeps stderr empty: one-shot commands write exactly one envelope on stdout; streaming commands write one NDJSON envelope per line. Drive the loop by parsing machine state — not by reading source or scraping human prose.',
    '',
    '## Agent-native loop',
    '',
    "- **Applicability**: when the request is unrelated to the Noodle MCP server or app, follow the project's normal instructions and run no Noodle lifecycle commands.",
    '- **Route first**: read the `noodle-seed` skill `SKILL.md`, choose exactly one primary route for the requested outcome, and read that primary reference. Read supporting references only when the route or observed evidence requires them.',
    "- Discover: `noodle commands --json` — every command, flag, and exit code (don't read source).",
    '- Author, when the selected route requires it: edit the configured TypeScript entrypoint — follow that route and its capability references.',
    '- Validate: `noodle validate --json` → on failure `{ok:false,error:{code,message,fix,next,errors:[{code,path,message}]}}`; per-field detail is in `error.errors[]`.',
    '- Repair: fix each `error.errors[]` entry at its `path`, re-run validate; `noodle validate --fix-prompt` gives ready repair prose. Never freeform re-edit.',
    '- Smoke: `noodle test --json`.',
    '- Continue only to the level the selected route requests: Apps/widgets use `noodle check --json` plus `noodle devtools`; hosted inspection stays read-only; hosted mutation runs only when the current user request explicitly authorizes the exact action and target.',
    '- Stale skill? `noodle agents doctor --json` → `noodle agents setup --write`.',
    '',
    'The exact `--json`/exit-code contract is in the `noodle-seed` skill and its `references/agent-contract.md`. Human-oriented command prose lives in the project README, not here.',
    '',
    '## Safety',
    '',
    '- Keep secrets, bearer tokens, refresh tokens, static access keys, `.env` / `.env.noodle` values, and `~/.noodle/config.json` out of prompts, logs, docs, tests, and generated files.',
    '- Do not hand-author manifest JSON or YAML, runtime artifact JSON, connector IR, or hosted asset metadata.',
    '- Do not add static data-plane credential paths; hosted access is identity-based.',
    '- Never run `link`, hosted secret/variable/config/access changes, deploy, rollback, host configuration writes, or directory submission unless the current user request explicitly authorizes the exact mutation and target.',
    '',
    '## Project Defaults',
    '',
    ...projectLines(input.project),
    '',
    'Generated Noodle agent files are project-local and non-secret. Refresh them with `noodle agents setup --write`.',
  ].join('\n');
  return wrapManagedBlock(body);
}

export function wrapManagedBlock(body: string): string {
  const hash = contentHash(body);
  return [
    MANAGED_BEGIN,
    `<!-- noodle-agent-kit:${AGENT_KIT_VERSION} hash:${hash} -->`,
    body,
    MANAGED_END,
    '',
  ].join('\n');
}

export function reconcileManagedBlock(input: {
  readonly existing?: string;
  readonly block: string;
  readonly force?: boolean;
}): ManagedBlockResult {
  const existing = input.existing;
  if (existing === undefined) return { content: input.block, action: 'created' };
  const ranges = managedBlockRanges(existing);
  if (ranges.length > 1 && input.force !== true) {
    return {
      content: existing,
      action: 'skipped',
      reason: 'duplicate-managed-blocks',
    };
  }
  if (ranges.length === 0) {
    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    return { content: `${existing}${separator}${input.block}`, action: 'updated' };
  }
  const [range] = ranges;
  if (range === undefined) return { content: existing, action: 'skipped' };
  const current = existing.slice(range.start, range.end);
  if (current === input.block) return { content: existing, action: 'unchanged' };
  if (!managedBlockHashMatches(current) && input.force !== true) {
    return {
      content: existing,
      action: 'skipped',
      reason: 'user-edited-managed-block',
    };
  }
  const content = `${existing.slice(0, range.start)}${input.block.trimEnd()}${existing.slice(range.end)}`;
  return {
    content: content.endsWith('\n') ? content : `${content}\n`,
    action: input.force === true && !managedBlockHashMatches(current) ? 'overwritten' : 'updated',
  };
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function contentSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function renderPublishableSkills(
  registry: SkillRegistry = SKILL_REGISTRY,
): readonly PublishableSkillFile[] {
  const files: PublishableSkillFile[] = [];
  for (const target of TARGETS) {
    for (const file of renderRegisteredSkillFiles(registry, target)) {
      files.push({
        path: file.publishPath,
        content: file.content,
        agentTarget: target,
        skill: file.skill,
        skillVersion: file.skillVersion,
      });
    }
  }
  return files;
}

/**
 * Map each publishable skill file to its installed destination, per target. The CLI uses this to
 * apply registry-fresh content (keyed by installed path) over the bundled tree.
 */
export function skillFileMappings(
  registry: SkillRegistry = SKILL_REGISTRY,
): readonly SkillFileMapping[] {
  const mappings: SkillFileMapping[] = [];
  for (const target of TARGETS) {
    for (const file of renderRegisteredSkillFiles(registry, target)) {
      mappings.push({
        publishPath: file.publishPath,
        installedPath: file.installedPath,
        agentTarget: target,
        skill: file.skill,
        skillVersion: file.skillVersion,
      });
    }
  }
  return mappings;
}

export function renderAgentKitManifest(registry: SkillRegistry = SKILL_REGISTRY): AgentKitManifest {
  const files = renderPublishableSkills(registry);
  const installedByPublish = new Map(
    skillFileMappings(registry).map((mapping) => [mapping.publishPath, mapping.installedPath]),
  );
  return {
    schemaVersion: 2,
    packageVersion: AGENT_KIT_VERSION,
    files: files.map((file) => ({
      path: file.path,
      installedPath: installedByPublish.get(file.path) ?? failMissingMapping(file.path),
      sha256: contentSha256(file.content),
      agentTarget: file.agentTarget,
      skill: file.skill,
      skillVersion: file.skillVersion,
    })),
  };
}

function failMissingMapping(path: string): never {
  throw new Error(`missing installed mapping for publishable skill: ${path}`);
}

function projectLines(project: AgentProjectMetadata | undefined): readonly string[] {
  if (project === undefined) return ['- No project defaults resolved yet.'];
  const lines = [
    ['name', project.name],
    ['entrypoint', project.entrypoint],
    ['env', project.env],
    ['access', project.accessMode],
    ['template', project.template],
    ['org', project.org],
    ['app', project.app],
  ]
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([label, value]) => `- ${label}: ${value}`);
  return lines.length > 0 ? lines : ['- No project defaults resolved yet.'];
}

function managedBlockRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < content.length) {
    const start = content.indexOf(MANAGED_BEGIN, offset);
    if (start < 0) break;
    const endMarker = content.indexOf(MANAGED_END, start + MANAGED_BEGIN.length);
    if (endMarker < 0) break;
    ranges.push({ start, end: endMarker + MANAGED_END.length });
    offset = endMarker + MANAGED_END.length;
  }
  return ranges;
}

function managedBlockHashMatches(block: string): boolean {
  const lines = block.split('\n');
  const metadata = lines[1] ?? '';
  const match = /hash:([a-f0-9]{16})/.exec(metadata);
  if (match === null) return false;
  const body = lines
    .slice(2)
    .join('\n')
    .replace(/\n?<!-- END NOODLE AGENT CONTEXT -->\n?$/, '');
  return contentHash(body.trimEnd()) === match[1];
}

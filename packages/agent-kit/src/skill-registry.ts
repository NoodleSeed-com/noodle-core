import { createHash } from 'node:crypto';

export type AgentTarget = 'codex' | 'claude-code';

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/;
const HOSTS: readonly AgentTarget[] = ['codex', 'claude-code'];

export const INSTALLED_SKILL_ROOT_BY_TARGET: Readonly<Record<AgentTarget, string>> = {
  codex: '.agents/skills',
  'claude-code': '.claude/skills',
};

export interface SkillDefinitionFile {
  readonly relPath: string;
  readonly render: (host: AgentTarget) => string;
}

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly supportedHosts: readonly AgentTarget[];
  readonly renderBody: (host: AgentTarget) => string;
  readonly files: readonly SkillDefinitionFile[];
  /** Preserve the historical `skills/<host>/*` public package path for the front-door skill. */
  readonly publishAtTargetRoot?: boolean;
}

export interface SkillRegistry {
  readonly definitions: readonly SkillDefinition[];
}

export interface RegisteredSkillFile {
  readonly skill: string;
  readonly skillVersion: string;
  readonly agentTarget: AgentTarget;
  readonly relPath: string;
  readonly content: string;
  readonly publishPath: string;
  readonly installedPath: string;
}

export function defineSkillRegistry(definitions: readonly SkillDefinition[]): SkillRegistry {
  const names = new Set<string>();
  let targetRootCount = 0;
  const validated = definitions.map((definition) => {
    if (!SKILL_NAME_PATTERN.test(definition.name) || definition.name.length > 100) {
      throw new Error(`invalid skill name: ${definition.name}`);
    }
    if (names.has(definition.name)) throw new Error(`duplicate skill name: ${definition.name}`);
    names.add(definition.name);
    if (
      definition.description.trim().length === 0 ||
      definition.description.length > 300 ||
      definition.description.includes('\n')
    ) {
      throw new Error(`invalid skill description: ${definition.name}`);
    }
    if (!VERSION_PATTERN.test(definition.version)) {
      throw new Error(`invalid skill version: ${definition.name}`);
    }
    if (definition.supportedHosts.length === 0) {
      throw new Error(`skill requires a supported host: ${definition.name}`);
    }
    const supportedHosts = [...new Set(definition.supportedHosts)];
    if (
      supportedHosts.length !== definition.supportedHosts.length ||
      supportedHosts.some((host) => !HOSTS.includes(host))
    ) {
      throw new Error(`invalid supported host set: ${definition.name}`);
    }
    if (definition.publishAtTargetRoot === true) targetRootCount += 1;
    const paths = new Set<string>();
    const files = definition.files.map((file) => {
      if (
        !RELATIVE_PATH_PATTERN.test(file.relPath) ||
        file.relPath === 'SKILL.md' ||
        file.relPath.endsWith('/') ||
        file.relPath.length > 300
      ) {
        throw new Error(`invalid skill file path: ${definition.name}/${file.relPath}`);
      }
      if (paths.has(file.relPath)) {
        throw new Error(`duplicate skill file: ${definition.name}/${file.relPath}`);
      }
      paths.add(file.relPath);
      return Object.freeze({ ...file });
    });
    return Object.freeze({ ...definition, supportedHosts, files });
  });
  if (targetRootCount > 1) throw new Error('only one skill may publish at the target root');
  return Object.freeze({ definitions: Object.freeze(validated) });
}

export function renderRegisteredSkillFiles(
  registry: SkillRegistry,
  host: AgentTarget,
): readonly RegisteredSkillFile[] {
  if (!HOSTS.includes(host)) throw new Error(`unsupported agent target: ${host}`);
  const files: RegisteredSkillFile[] = [];
  const publishPaths = new Set<string>();
  const installedPaths = new Set<string>();
  for (const definition of registry.definitions) {
    if (!definition.supportedHosts.includes(host)) continue;
    const body = definition.renderBody(host);
    if (body.trim().length === 0) throw new Error(`empty skill body: ${definition.name}`);
    const rendered = [
      { relPath: 'SKILL.md', content: stampSkill(definition, body) },
      ...definition.files.map((file) => ({ relPath: file.relPath, content: file.render(host) })),
    ];
    const publishBase = definition.publishAtTargetRoot
      ? `skills/${host}`
      : `skills/${host}/${definition.name}`;
    const installedBase = `${INSTALLED_SKILL_ROOT_BY_TARGET[host]}/${definition.name}`;
    for (const file of rendered) {
      if (file.content.trim().length === 0) {
        throw new Error(`empty skill file: ${definition.name}/${file.relPath}`);
      }
      const publishPath = `${publishBase}/${file.relPath}`;
      const installedPath = `${installedBase}/${file.relPath}`;
      if (publishPaths.has(publishPath) || installedPaths.has(installedPath)) {
        throw new Error(`duplicate rendered skill path: ${definition.name}/${file.relPath}`);
      }
      publishPaths.add(publishPath);
      installedPaths.add(installedPath);
      files.push({
        skill: definition.name,
        skillVersion: definition.version,
        agentTarget: host,
        relPath: file.relPath,
        content: file.content,
        publishPath,
        installedPath,
      });
    }
  }
  return files;
}

function stampSkill(definition: SkillDefinition, body: string): string {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
  return [
    '---',
    `name: ${definition.name}`,
    `description: ${JSON.stringify(definition.description)}`,
    '---',
    '',
    `<!-- noodle-skill version:${definition.version} hash:${hash} -->`,
    '',
    body,
    '',
  ].join('\n');
}

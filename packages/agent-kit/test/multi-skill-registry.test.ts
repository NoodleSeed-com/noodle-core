import { describe, expect, it } from 'vitest';
import {
  contentSha256,
  renderAgentFiles,
  renderAgentKitManifest,
  renderPublishableSkills,
  skillFileMappings,
} from '../src/index.js';
import {
  defineSkillRegistry,
  INSTALLED_SKILL_ROOT_BY_TARGET,
  renderRegisteredSkillFiles,
  type SkillDefinition,
} from '../src/skill-registry.js';

function skill(name: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name,
    description: `Use when the request needs ${name.replaceAll('-', ' ')}.`,
    version: '1.2.3',
    supportedHosts: ['codex', 'claude-code'],
    renderBody: (host) => `# ${name}\n\nHost: ${host}.`,
    files: [{ relPath: 'references/workflow.md', render: () => `# ${name} workflow\n` }],
    ...overrides,
  };
}

describe('multi-skill registry', () => {
  it('renders a complete two-skill tree for both hosts with independent identity and hashes', () => {
    const registry = defineSkillRegistry([
      skill('noodle-seed', { publishAtTargetRoot: true }),
      skill('noodle-verify'),
    ]);

    for (const host of ['codex', 'claude-code'] as const) {
      const files = renderRegisteredSkillFiles(registry, host);
      expect(files.map((file) => file.installedPath)).toEqual([
        `${INSTALLED_SKILL_ROOT_BY_TARGET[host]}/noodle-seed/SKILL.md`,
        `${INSTALLED_SKILL_ROOT_BY_TARGET[host]}/noodle-seed/references/workflow.md`,
        `${INSTALLED_SKILL_ROOT_BY_TARGET[host]}/noodle-verify/SKILL.md`,
        `${INSTALLED_SKILL_ROOT_BY_TARGET[host]}/noodle-verify/references/workflow.md`,
      ]);
      expect(files.map((file) => file.publishPath)).toEqual([
        `skills/${host}/SKILL.md`,
        `skills/${host}/references/workflow.md`,
        `skills/${host}/noodle-verify/SKILL.md`,
        `skills/${host}/noodle-verify/references/workflow.md`,
      ]);
      expect(files.filter((file) => file.relPath === 'SKILL.md')).toEqual([
        expect.objectContaining({ skill: 'noodle-seed', skillVersion: '1.2.3' }),
        expect.objectContaining({ skill: 'noodle-verify', skillVersion: '1.2.3' }),
      ]);
      for (const file of files.filter((entry) => entry.relPath === 'SKILL.md')) {
        expect(file.content).toContain(`name: ${file.skill}`);
        expect(file.content).toContain('version:1.2.3');
        expect(file.content).toMatch(/hash:[a-f0-9]{16}/);
      }
    }
  });

  it('keeps host support explicit without emitting partial trees', () => {
    const registry = defineSkillRegistry([
      skill('noodle-seed', { publishAtTargetRoot: true }),
      skill('codex-only', { supportedHosts: ['codex'] }),
    ]);

    expect(
      renderRegisteredSkillFiles(registry, 'codex').some((file) => file.skill === 'codex-only'),
    ).toBe(true);
    expect(
      renderRegisteredSkillFiles(registry, 'claude-code').some(
        (file) => file.skill === 'codex-only',
      ),
    ).toBe(false);
  });

  it.each([
    {
      name: 'duplicate skill identity',
      definitions: [skill('duplicate'), skill('duplicate')],
      message: /duplicate skill name/,
    },
    {
      name: 'duplicate relative path',
      definitions: [
        skill('duplicate-file', {
          files: [
            { relPath: 'references/workflow.md', render: () => 'one' },
            { relPath: 'references/workflow.md', render: () => 'two' },
          ],
        }),
      ],
      message: /duplicate skill file/,
    },
    {
      name: 'two legacy publish roots',
      definitions: [
        skill('first', { publishAtTargetRoot: true }),
        skill('second', { publishAtTargetRoot: true }),
      ],
      message: /publish at the target root/,
    },
    {
      name: 'path traversal',
      definitions: [
        skill('unsafe-path', {
          files: [{ relPath: '../outside.md', render: () => 'unsafe' }],
        }),
      ],
      message: /invalid skill file path/,
    },
    {
      name: 'empty host set',
      definitions: [skill('hostless', { supportedHosts: [] })],
      message: /supported host/,
    },
  ])('fails closed for $name', ({ definitions, message }) => {
    expect(() => defineSkillRegistry(definitions)).toThrow(message);
  });

  it('rejects a renderer that changes file identity or returns empty content', () => {
    const registry = defineSkillRegistry([
      skill('empty-file', {
        files: [{ relPath: 'references/empty.md', render: () => '' }],
      }),
    ]);

    expect(() => renderRegisteredSkillFiles(registry, 'codex')).toThrow(
      /empty-file.*references\/empty\.md/,
    );
  });

  it('projects the complete registry bijectively across install, publish, and manifest surfaces', () => {
    const registry = defineSkillRegistry([
      skill('noodle-seed', { publishAtTargetRoot: true }),
      skill('noodle-verify'),
    ]);
    const installed = renderAgentFiles({ targets: ['codex'], registry }).filter(
      (file) => file.mode === 'generated-file',
    );
    const published = renderPublishableSkills(registry).filter(
      (file) => file.agentTarget === 'codex',
    );
    const mappings = skillFileMappings(registry).filter(
      (mapping) => mapping.agentTarget === 'codex',
    );
    const manifest = renderAgentKitManifest(registry);

    expect(manifest.schemaVersion).toBe(2);
    expect(installed).toHaveLength(4);
    expect(published).toHaveLength(4);
    expect(mappings).toHaveLength(4);
    expect(new Set(mappings.map((mapping) => mapping.publishPath)).size).toBe(4);
    expect(new Set(mappings.map((mapping) => mapping.installedPath)).size).toBe(4);
    for (const mapping of mappings) {
      const source = published.find((file) => file.path === mapping.publishPath);
      const destination = installed.find((file) => file.path === mapping.installedPath);
      expect(source?.content).toBe(destination?.content);
      expect(source?.skill).toBe(mapping.skill);
      expect(destination?.skill).toBe(mapping.skill);
      expect(manifest.files.find((file) => file.path === mapping.publishPath)).toMatchObject({
        skill: mapping.skill,
        skillVersion: mapping.skillVersion,
        installedPath: mapping.installedPath,
        sha256: contentSha256(source?.content ?? ''),
      });
    }
  });
});

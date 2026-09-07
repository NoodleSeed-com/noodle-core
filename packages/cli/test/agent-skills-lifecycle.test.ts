import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSkillRegistry, type SkillDefinition } from '@noodle-borg/agent-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgents, setupAgents } from '../src/agents.js';

function definition(name: string): SkillDefinition {
  return {
    name,
    description: `Use when ${name} is explicitly requested.`,
    version: '1.0.0',
    supportedHosts: ['codex', 'claude-code'],
    renderBody: () => `# ${name}\n`,
    files: [{ relPath: 'references/contract.md', render: () => `# ${name} contract\n` }],
  };
}

describe('managed agent skill lifecycle', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'noodle-skill-lifecycle-'));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('installs every registered skill and commits an ownership manifest last', () => {
    const registry = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);

    const report = setupAgents({
      agents: ['codex'],
      project,
      write: true,
      force: false,
      json: false,
      registry,
    });

    expect(existsSync(join(project, '.agents/skills/noodle-seed/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/noodle-verify/SKILL.md'))).toBe(true);
    const state = JSON.parse(
      readFileSync(join(project, '.agents/skills/.noodle-managed.json'), 'utf8'),
    ) as { schemaVersion: number; files: Array<{ path: string; skill: string }> };
    expect(state.schemaVersion).toBe(1);
    expect(state.files).toHaveLength(4);
    expect(new Set(state.files.map((file) => file.skill))).toEqual(
      new Set(['noodle-seed', 'noodle-verify']),
    );
    expect(report.files.some((file) => file.path.endsWith('.noodle-managed.json'))).toBe(false);
  });

  it('removes stale generated files only when their owned hash is unchanged', () => {
    const initial = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);
    const reduced = defineSkillRegistry([definition('noodle-seed')]);
    const input = {
      agents: ['codex'] as const,
      project,
      write: true,
      force: false,
      json: false,
    };
    setupAgents({ ...input, registry: initial });

    const report = setupAgents({ ...input, registry: reduced });

    expect(existsSync(join(project, '.agents/skills/noodle-verify/SKILL.md'))).toBe(false);
    expect(existsSync(join(project, '.agents/skills/noodle-verify/references/contract.md'))).toBe(
      false,
    );
    expect(
      report.files.filter(
        (file) => file.action === 'removed' && file.path.includes('/noodle-verify/'),
      ),
    ).toHaveLength(2);
  });

  it('preserves a user-edited stale file and reports why it was skipped', () => {
    const initial = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);
    const reduced = defineSkillRegistry([definition('noodle-seed')]);
    const input = {
      agents: ['codex'] as const,
      project,
      write: true,
      force: false,
      json: false,
    };
    setupAgents({ ...input, registry: initial });
    const edited = join(project, '.agents/skills/noodle-verify/SKILL.md');
    writeFileSync(edited, '# user-owned edit\n');

    const report = setupAgents({ ...input, registry: reduced });

    expect(readFileSync(edited, 'utf8')).toBe('# user-owned edit\n');
    expect(report.files).toContainEqual({
      path: '.agents/skills/noodle-verify/SKILL.md',
      target: 'codex',
      action: 'skipped',
      reason: 'user-edited-removed-generated-file',
    });
  });

  it('upgrades a legacy single-skill tree without an ownership manifest', () => {
    const legacy = defineSkillRegistry([definition('noodle-seed')]);
    const current = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);
    setupAgents({
      agents: ['codex'],
      project,
      write: true,
      force: false,
      json: false,
      registry: legacy,
    });
    rmSync(join(project, '.agents/skills/.noodle-managed.json'));

    const report = setupAgents({
      agents: ['codex'],
      project,
      write: true,
      force: false,
      json: false,
      registry: current,
    });

    expect(existsSync(join(project, '.agents/skills/noodle-verify/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/.noodle-managed.json'))).toBe(true);
    expect(report.files.some((file) => file.path.includes('/noodle-verify/'))).toBe(true);
  });

  it('rejects an incomplete remote host snapshot before writing project files', () => {
    expect(() =>
      setupAgents({
        agents: ['codex', 'claude-code'],
        project,
        write: true,
        force: false,
        json: false,
        skillsOverride: {
          packageVersion: '1.0.0',
          files: [
            {
              path: '.agents/skills/noodle-seed/SKILL.md',
              content: '# remote\n',
              target: 'codex',
              skill: 'noodle-seed',
              skillVersion: '1.0.0',
            },
          ],
        },
      }),
    ).toThrow(/missing claude-code/);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(project, 'CLAUDE.md'))).toBe(false);
  });

  it.each([
    ['codex', '.agents/skills', 'AGENTS.md'],
    ['claude-code', '.claude/skills', 'CLAUDE.md'],
  ] as const)('rejects a symlinked %s skill root before writing outside the project', (target, skillRoot, managedFile) => {
    const outside = mkdtempSync(join(tmpdir(), 'noodle-skill-outside-'));
    mkdirSync(join(project, skillRoot, '..'), { recursive: true });
    symlinkSync(outside, join(project, skillRoot), 'dir');

    try {
      expect(() =>
        setupAgents({
          agents: [target],
          project,
          write: true,
          force: false,
          json: false,
          registry: defineSkillRegistry([definition('noodle-seed')]),
        }),
      ).toThrow(/symbolic link/);
      expect(existsSync(join(outside, 'noodle-seed/SKILL.md'))).toBe(false);
      expect(existsSync(join(project, managedFile))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects stale-file removal through a symlinked skill root', () => {
    const outsideProject = mkdtempSync(join(tmpdir(), 'noodle-skill-outside-project-'));
    const initial = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);
    const reduced = defineSkillRegistry([definition('noodle-seed')]);
    setupAgents({
      agents: ['codex'],
      project: outsideProject,
      write: true,
      force: false,
      json: false,
      registry: initial,
    });
    mkdirSync(join(project, '.agents'), { recursive: true });
    symlinkSync(join(outsideProject, '.agents/skills'), join(project, '.agents/skills'), 'dir');
    const stale = join(outsideProject, '.agents/skills/noodle-verify/SKILL.md');

    try {
      expect(() =>
        setupAgents({
          agents: ['codex'],
          project,
          write: true,
          force: false,
          json: false,
          registry: reduced,
        }),
      ).toThrow(/symbolic link/);
      expect(existsSync(stale)).toBe(true);
      expect(existsSync(join(project, 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(outsideProject, { recursive: true, force: true });
    }
  });

  it('doctor reports exact drift for an independently registered sibling skill', async () => {
    const registry = defineSkillRegistry([definition('noodle-seed'), definition('noodle-verify')]);
    setupAgents({
      agents: ['codex'],
      project,
      write: true,
      force: false,
      json: false,
      registry,
    });
    writeFileSync(
      join(project, '.agents/skills/noodle-verify/references/contract.md'),
      '# modified\n',
    );
    const siblingSkill = join(project, '.agents/skills/noodle-verify/SKILL.md');
    writeFileSync(siblingSkill, `${readFileSync(siblingSkill, 'utf8')}user edit\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await runAgents(['doctor', '--agents', 'codex', '--project', project], {
          NOODLE_DISABLE_UPDATE_CHECK: '1',
        }),
      ).toBe(0);
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'WARN .agents/skills/noodle-verify/references/contract.md: modified; run noodle agents setup --write',
      );
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'WARN .agents/skills/noodle-verify/SKILL.md: modified; run noodle agents setup --write',
      );
    } finally {
      log.mockRestore();
    }
  });
});

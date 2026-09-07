import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAgents } from '../src/agents.js';

interface SetupTargetReport {
  readonly target: 'codex' | 'claude-code';
  readonly status: 'created' | 'updated' | 'unchanged' | 'modified' | 'stale' | 'removed';
  readonly applied?: boolean;
  readonly requiresRegeneration?: boolean;
  readonly stateAction?: 'created' | 'updated' | 'unchanged' | 'migrated' | 'removed';
  readonly files: readonly { readonly path: string; readonly action: string }[];
}

interface ProductSkillSetupReport {
  readonly ok: boolean;
  readonly app: { readonly name: string; readonly skillSlug: string };
  readonly sourceManifestSha256: string;
  readonly mcpSurfaceSha256: string;
  readonly rendererVersion: string;
  readonly targets: readonly SetupTargetReport[];
}

interface SetupReport {
  readonly ok: boolean;
  readonly productSkill?: ProductSkillSetupReport;
}

interface DoctorReport {
  readonly checks: readonly {
    readonly name: string;
    readonly level: string;
    readonly message: string;
    readonly code?: string;
  }[];
  readonly nextCommands?: readonly { readonly command: string; readonly reason: string }[];
}

const fixtures = join(import.meta.dirname, 'fixtures');

describe.sequential('project-local app product-skill lifecycle', () => {
  let project: string;
  let home: string;
  let log: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'noodle-agent-product-project-'));
    home = mkdtempSync(join(tmpdir(), 'noodle-agent-product-home-'));
    cpSync(join(fixtures, 'modern-guided', 'server.ts'), join(project, 'server.ts'));
    writeFileSync(
      join(project, 'noodle.json'),
      `${JSON.stringify({ entrypoint: 'server.ts', name: 'modern-guided' })}\n`,
    );
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    log.mockRestore();
    error.mockRestore();
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  async function setupJson(...flags: readonly string[]): Promise<{
    readonly exitCode: number;
    readonly data?: SetupReport;
    readonly failure?: {
      readonly code: string;
      readonly detail?: { readonly report?: SetupReport };
    };
  }> {
    log.mockClear();
    const exitCode = await runAgents(
      ['setup', '--agents', 'all', '--project', project, '--json', ...flags],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    const envelope = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as {
      readonly ok: boolean;
      readonly data?: SetupReport;
      readonly error?: {
        readonly code: string;
        readonly detail?: { readonly report?: SetupReport };
      };
    };
    return { exitCode, data: envelope.data, failure: envelope.error };
  }

  async function doctorJson(): Promise<{ readonly exitCode: number; readonly data: DoctorReport }> {
    log.mockClear();
    const exitCode = await runAgents(
      ['doctor', '--agents', 'all', '--project', project, '--json'],
      { NOODLE_DISABLE_UPDATE_CHECK: '1' },
      home,
    );
    const envelope = JSON.parse(log.mock.calls.map((call) => String(call[0])).join('\n')) as
      | { readonly ok: true; readonly data: DoctorReport }
      | {
          readonly ok: false;
          readonly error: { readonly detail?: DoctorReport };
        };
    const data = envelope.ok ? envelope.data : envelope.error.detail;
    if (data === undefined) throw new Error('doctor JSON response omitted its checks');
    return { exitCode, data };
  }

  it('previews, explicitly writes, and idempotently discovers the app skill in both hosts', async () => {
    const preview = await setupJson();
    expect(preview.exitCode).toBe(0);
    expect(preview.data?.productSkill).toMatchObject({
      ok: true,
      app: { name: 'modern_guided', skillSlug: 'modern-guided' },
      targets: [
        { target: 'codex', status: 'created' },
        { target: 'claude-code', status: 'created' },
      ],
    });
    expect(preview.data?.productSkill?.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.data?.productSkill?.mcpSurfaceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(false);

    const written = await setupJson('--write');
    expect(written.exitCode).toBe(0);
    expect(written.data?.productSkill?.targets.map((target) => target.status)).toEqual([
      'created',
      'created',
    ]);
    for (const path of [
      '.agents/skills/modern-guided/SKILL.md',
      '.agents/skills/modern-guided/references/mcp-surface.md',
      '.claude/skills/modern-guided/SKILL.md',
      '.claude/skills/modern-guided/references/mcp-surface.md',
    ]) {
      expect(readFileSync(join(project, path), 'utf8')).toContain('Modern Guided');
    }
    for (const path of [
      '.agents/skills/.noodle-app-package.json',
      '.claude/skills/.noodle-app-package.json',
    ]) {
      const state = JSON.parse(readFileSync(join(project, path), 'utf8')) as {
        readonly schemaVersion: number;
        readonly bundleSchemaVersion: number;
        readonly app: { readonly name: string; readonly skillSlug: string };
        readonly files: readonly unknown[];
      };
      expect(state).toMatchObject({
        schemaVersion: 2,
        bundleSchemaVersion: 1,
        app: { name: 'modern_guided', skillSlug: 'modern-guided' },
      });
      expect(state.files).toHaveLength(2);
    }
    expect(existsSync(join(project, '.agents/skills/.noodle-managed.json'))).toBe(true);

    const rerun = await setupJson('--write');
    expect(rerun.exitCode).toBe(0);
    expect(rerun.data?.productSkill?.targets.map((target) => target.status)).toEqual([
      'unchanged',
      'unchanged',
    ]);

    unlinkSync(join(project, '.agents/skills/.noodle-app-package.json'));
    const adopted = await setupJson('--write');
    expect(adopted.exitCode).toBe(0);
    expect(adopted.data?.productSkill?.targets[0]).toMatchObject({
      target: 'codex',
      status: 'unchanged',
    });
    expect(existsSync(join(project, '.agents/skills/.noodle-app-package.json'))).toBe(true);
  });

  it('never overwrites a modified generated app file through the broad --force flag', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const path = join(project, '.agents/skills/modern-guided/SKILL.md');
    const modified = `${readFileSync(path, 'utf8')}\nUser-owned note.\n`;
    writeFileSync(path, modified);

    const result = await setupJson('--write', '--force');

    expect(result.exitCode).toBe(1);
    expect(result.failure?.code).toBe('agent_skill_modified');
    expect(result.failure?.detail?.report?.productSkill?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'codex', status: 'modified' }),
        expect.objectContaining({ target: 'claude-code', status: 'unchanged' }),
      ]),
    );
    expect(readFileSync(path, 'utf8')).toBe(modified);
  });

  it('replaces previously owned modified bytes only through the narrow explicit recovery flag', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const path = join(project, '.agents/skills/modern-guided/SKILL.md');
    const generated = readFileSync(path, 'utf8');
    writeFileSync(path, `${generated}\nLocal modification.\n`);

    const preview = await setupJson('--regenerate-app-skill', '--replace-modified-app-skill');
    expect(preview.exitCode).toBe(0);
    expect(preview.data?.productSkill?.targets[0]).toMatchObject({
      target: 'codex',
      status: 'updated',
      applied: false,
      requiresRegeneration: true,
    });
    expect(readFileSync(path, 'utf8')).toContain('Local modification.');

    const replaced = await setupJson(
      '--write',
      '--regenerate-app-skill',
      '--replace-modified-app-skill',
    );
    expect(replaced.exitCode).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(generated);
  });

  it('classifies malformed ownership as invalid state instead of an ordinary modification', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const statePath = join(project, '.agents/skills/.noodle-app-package.json');
    const malformed = '{"schemaVersion":1';
    writeFileSync(statePath, malformed);

    const diagnosis = await doctorJson();

    expect(diagnosis.exitCode).toBe(1);
    expect(diagnosis.data.checks).toContainEqual(
      expect.objectContaining({
        name: 'Codex app product skill',
        level: 'FAIL',
        code: 'agent_skill_invalid_state',
      }),
    );
    expect(readFileSync(statePath, 'utf8')).toBe(malformed);

    const setup = await setupJson('--write', '--force');
    expect(setup.exitCode).toBe(1);
    expect(setup.failure?.code).toBe('agent_skill_invalid_state');
    expect(readFileSync(statePath, 'utf8')).toBe(malformed);
  });

  it('rejects an ownership record that claims another skill directory', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const customFiles = [
      { path: '.agents/skills/custom/SKILL.md', content: '# Custom user skill\n' },
      {
        path: '.agents/skills/custom/references/mcp-surface.md',
        content: '# Custom reference\n',
      },
    ];
    for (const file of customFiles) {
      mkdirSync(join(project, file.path, '..'), { recursive: true });
      writeFileSync(join(project, file.path), file.content);
    }
    const statePath = join(project, '.agents/skills/.noodle-app-package.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          ...state,
          app: { name: 'modern_guided', skillSlug: 'custom' },
          files: customFiles.map((file) => ({
            path: file.path,
            sha256: createHash('sha256').update(file.content).digest('hex'),
            byteLength: Buffer.byteLength(file.content),
          })),
        },
        null,
        2,
      )}\n`,
    );

    const result = await setupJson(
      '--write',
      '--regenerate-app-skill',
      '--replace-modified-app-skill',
    );

    expect(result.exitCode).toBe(1);
    expect(result.failure?.code).toBe('agent_skill_invalid_state');
    for (const file of customFiles) {
      expect(readFileSync(join(project, file.path), 'utf8')).toBe(file.content);
    }
  });

  it('keeps targets independent when one host path collides before first install', async () => {
    const collision = join(project, '.agents/skills/modern-guided/SKILL.md');
    mkdirSync(join(collision, '..'), { recursive: true });
    writeFileSync(collision, '# Existing project skill\n', { flag: 'wx' });

    const result = await setupJson(
      '--write',
      '--force',
      '--regenerate-app-skill',
      '--replace-modified-app-skill',
    );

    expect(result.exitCode).toBe(1);
    expect(result.failure?.code).toBe('agent_skill_modified');
    expect(readFileSync(collision, 'utf8')).toBe('# Existing project skill\n');
    expect(existsSync(join(project, '.agents/skills/.noodle-app-package.json'))).toBe(false);
    expect(existsSync(join(project, '.claude/skills/modern-guided/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.claude/skills/.noodle-app-package.json'))).toBe(true);
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
  });

  it('doctor reports an unexpected unowned app-skill file as a collision', async () => {
    const unexpected = join(project, '.agents/skills/modern-guided/notes.md');
    mkdirSync(join(unexpected, '..'), { recursive: true });
    writeFileSync(unexpected, '# Project-owned notes\n');

    const diagnosis = await doctorJson();

    expect(diagnosis.exitCode).toBe(0);
    expect(diagnosis.data.checks).toContainEqual(
      expect.objectContaining({
        name: 'Codex app product skill',
        level: 'WARN',
        code: 'agent_skill_modified',
        message: expect.stringContaining('unowned'),
      }),
    );
    expect(readFileSync(unexpected, 'utf8')).toBe('# Project-owned notes\n');
  });

  it('doctor distinguishes modified bytes from a stale source package and regeneration stays explicit', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const skillPath = join(project, '.agents/skills/modern-guided/SKILL.md');
    const originalSkill = readFileSync(skillPath, 'utf8');
    writeFileSync(skillPath, `${originalSkill}\nUser note.\n`);

    const modified = await doctorJson();
    expect(modified.exitCode).toBe(0);
    expect(modified.data.checks).toContainEqual(
      expect.objectContaining({
        name: 'Codex app product skill',
        level: 'WARN',
        code: 'agent_skill_modified',
      }),
    );
    expect(modified.data.nextCommands?.[0]?.command).toBe('noodle agents setup');
    expect(readFileSync(skillPath, 'utf8')).toContain('User note.');

    writeFileSync(skillPath, originalSkill);
    const sourcePath = join(project, 'server.ts');
    const originalSource = readFileSync(sourcePath, 'utf8');
    writeFileSync(
      sourcePath,
      originalSource.replace(
        'Use Modern Guided to review and complete tasks.',
        'Use Modern Guided to safely review and complete tasks.',
      ),
    );

    const stale = await doctorJson();
    expect(stale.exitCode).toBe(0);
    expect(stale.data.checks).toContainEqual(
      expect.objectContaining({
        name: 'Codex app product skill',
        level: 'WARN',
        code: 'agent_skill_stale',
      }),
    );
    expect(stale.data.nextCommands?.[0]?.command).toBe('noodle agents setup');
    expect(readFileSync(skillPath, 'utf8')).toBe(originalSkill);

    const preview = await setupJson();
    expect(preview.data?.productSkill?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'updated',
          applied: false,
          requiresRegeneration: true,
        }),
      ]),
    );
    expect(readFileSync(skillPath, 'utf8')).toBe(originalSkill);

    const workflowSkill = join(project, '.agents/skills/noodle-seed/SKILL.md');
    writeFileSync(workflowSkill, '# stale Noodle workflow skill\n');
    const refreshOnly = await setupJson('--write');
    expect(refreshOnly.exitCode).toBe(0);
    expect(readFileSync(workflowSkill, 'utf8')).not.toBe('# stale Noodle workflow skill\n');
    expect(readFileSync(skillPath, 'utf8')).toBe(originalSkill);

    const updated = await setupJson('--write', '--regenerate-app-skill');
    expect(updated.exitCode).toBe(0);
    expect(readFileSync(skillPath, 'utf8')).toContain('safely review and complete tasks');
    const current = await doctorJson();
    expect(current.data.checks).toContainEqual(
      expect.objectContaining({ name: 'Codex app product skill', level: 'PASS' }),
    );
  });

  it('previews and explicitly applies a V1 to V2 ownership migration', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const statePath = join(project, '.agents/skills/.noodle-app-package.json');
    const current = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    const { bundleSchemaVersion: _bundleSchemaVersion, ...legacy } = current;
    writeFileSync(statePath, `${JSON.stringify({ ...legacy, schemaVersion: 1 }, null, 2)}\n`);

    const preview = await setupJson();
    expect(preview.exitCode).toBe(0);
    expect(preview.data?.productSkill?.targets[0]).toMatchObject({
      target: 'codex',
      status: 'stale',
      applied: false,
      requiresRegeneration: true,
      stateAction: 'migrated',
    });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).schemaVersion).toBe(1);

    expect((await setupJson('--write')).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).schemaVersion).toBe(1);

    expect((await setupJson('--write', '--regenerate-app-skill')).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      bundleSchemaVersion: 1,
    });
  });

  it('previews and explicitly reconciles an app-skill rename', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const sourcePath = join(project, 'server.ts');
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8').replace("'modern_guided'", "'modern_guided_v2'"),
    );

    const preview = await setupJson();
    expect(preview.exitCode).toBe(0);
    expect(preview.data?.productSkill?.targets[0]).toMatchObject({
      status: 'updated',
      applied: false,
      requiresRegeneration: true,
    });
    expect(preview.data?.productSkill?.targets[0]?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.agents/skills/modern-guided/SKILL.md',
          action: 'removed',
        }),
        expect.objectContaining({
          path: '.agents/skills/modern-guided-v2/SKILL.md',
          action: 'created',
        }),
      ]),
    );
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(true);

    expect((await setupJson('--write', '--regenerate-app-skill')).exitCode).toBe(0);
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(false);
    expect(existsSync(join(project, '.agents/skills/modern-guided-v2/SKILL.md'))).toBe(true);
  });

  it('previews and explicitly removes an unchanged orphaned app skill', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    cpSync(join(fixtures, 'hello', 'server.ts'), join(project, 'server.ts'));

    const preview = await setupJson();
    expect(preview.exitCode).toBe(0);
    expect(preview.data?.productSkill?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'removed',
          applied: false,
          requiresRegeneration: true,
          stateAction: 'removed',
        }),
      ]),
    );
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(true);

    expect((await setupJson('--write', '--regenerate-app-skill')).exitCode).toBe(0);
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(false);
    expect(existsSync(join(project, '.agents/skills/.noodle-app-package.json'))).toBe(false);
  });

  it('restores a missing owned file only after explicit app-skill regeneration', async () => {
    expect((await setupJson('--write')).exitCode).toBe(0);
    const reference = join(project, '.agents/skills/modern-guided/references/mcp-surface.md');
    unlinkSync(reference);

    const diagnosis = await doctorJson();
    expect(diagnosis.data.checks).toContainEqual(
      expect.objectContaining({
        name: 'Codex app product skill',
        level: 'WARN',
        code: 'agent_skill_stale',
      }),
    );
    const preview = await setupJson();
    expect(preview.data?.productSkill?.targets[0]?.files).toContainEqual({
      path: '.agents/skills/modern-guided/references/mcp-surface.md',
      action: 'created',
    });
    expect(existsSync(reference)).toBe(false);
    expect((await setupJson('--write')).exitCode).toBe(0);
    expect(existsSync(reference)).toBe(false);
    expect((await setupJson('--write', '--regenerate-app-skill')).exitCode).toBe(0);
    expect(existsSync(reference)).toBe(true);
  });

  it('still reconciles Noodle workflow guidance when the local app cannot compile', async () => {
    writeFileSync(join(project, 'server.ts'), 'export default this is not valid TypeScript;\n');

    const result = await setupJson('--write');

    expect(result.exitCode).toBe(1);
    expect(result.failure?.code).toBe('agent_skill_stale');
    expect(existsSync(join(project, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/noodle-seed/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.agents/skills/modern-guided/SKILL.md'))).toBe(false);
  });

  it('leaves the existing setup report unchanged for an app without an agent guide', async () => {
    cpSync(join(fixtures, 'hello', 'server.ts'), join(project, 'server.ts'));

    const result = await setupJson();

    expect(result.exitCode).toBe(0);
    expect(result.data?.productSkill).toBeUndefined();
  });
});

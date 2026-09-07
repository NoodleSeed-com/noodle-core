import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapProject } from '../src/project-bootstrap.js';
import type { launchBootstrapAgent } from '../src/project-bootstrap-launch.js';
import type { BootstrapExecutor } from '../src/project-bootstrap-process.js';
import { readBootstrapState } from '../src/project-bootstrap-state.js';
import { currentCliVersion } from '../src/update.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'noodle-bootstrap-'));
  roots.push(root);
  const project = join(root, 'project');
  let fail: string | undefined;
  const calls: string[][] = [];
  const execute: BootstrapExecutor = async (command, args, options) => {
    calls.push([command, ...args]);
    if (args.includes(fail ?? '\0')) return { ok: false, code: 'command_failed', stdout: '' };
    if (args[0] === '--version') return { ok: true, stdout: '11.5.2\n' };
    if (args[0] === 'install' || args[0] === 'ci') {
      const cli = join(options.cwd, 'node_modules/@noodleseed/one');
      mkdirSync(join(cli, 'dist'), { recursive: true });
      writeFileSync(
        join(cli, 'package.json'),
        JSON.stringify({
          name: '@noodleseed/one',
          version: currentCliVersion(),
          bin: { noodle: 'dist/bin.js' },
        }),
      );
      writeFileSync(join(cli, 'dist/bin.js'), '// isolated test double');
      writeFileSync(
        join(options.cwd, command === 'pnpm' ? 'pnpm-lock.yaml' : 'package-lock.json'),
        '{}\n',
      );
    }
    return { ok: true, stdout: '{"ok":true,"data":{}}\n' };
  };
  const run = (extra = {}) =>
    bootstrapProject(
      { dir: project, template: 'hello', agentTargets: [], ...extra },
      { env: { PATH: process.env.PATH }, execute },
    );
  return {
    root,
    project,
    calls,
    execute,
    run,
    failAt(value?: string) {
      fail = value;
    },
  };
}

describe('one-command local bootstrap', () => {
  it('installs and verifies through the project-local CLI without login or global mutation', async () => {
    const f = fixture();
    const result = await f.run();
    expect(result.setup.ready).toBe(true);
    expect(result.setup.completed).toEqual([
      'scaffold',
      'install',
      'validate',
      'behavior',
      'types',
    ]);
    expect(
      f.calls.some((call) =>
        call.includes(join(f.project, 'node_modules/@noodleseed/one/dist/bin.js')),
      ),
    ).toBe(true);
    expect(f.calls.some((call) => call.includes('test'))).toBe(true);
    expect(
      f.calls
        .flat()
        .some((value) => ['login', 'deploy', '-g', '--global', 'update'].includes(value)),
    ).toBe(false);
    expect(readBootstrapState(f.project)?.dependencyFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    'install',
    'validate',
    'test',
    'typecheck',
  ])('reports and safely resumes a failed %s', async (failed) => {
    const f = fixture();
    f.failAt(failed);
    const first = await f.run();
    expect(first.setup.ready).toBe(false);
    expect(first.setup.failed?.code).toBe('command_failed');
    expect(first.setup.resumeCommand).not.toContain('--force');
    expect(first.setup.nextSteps.length).toBeGreaterThan(0);
    expect(readBootstrapState(f.project)?.failed).toEqual(first.setup.failed);
    const source = join(f.project, 'src/server.ts');
    writeFileSync(source, `${readFileSync(source, 'utf8')}\n// customer modification\n`);
    writeFileSync(join(f.project, '.env'), 'PRIVATE_VALUE=do-not-reflect\n');
    f.failAt();
    const resumed = await f.run();
    expect(resumed.setup.ready).toBe(true);
    expect(readFileSync(source, 'utf8')).toContain('// customer modification');
    expect(readFileSync(join(f.project, '.env'), 'utf8')).toContain('do-not-reflect');
    expect(JSON.stringify(resumed)).not.toContain('do-not-reflect');
    expect(f.calls.filter((call) => call[1] === 'install' || call[1] === 'ci')).toHaveLength(
      failed === 'install' ? 2 : 1,
    );
  });

  it('reruns verification but not an unchanged completed installation', async () => {
    const f = fixture();
    await f.run();
    await f.run();
    expect(f.calls.filter((call) => call[1] === 'install')).toHaveLength(1);
    expect(f.calls.filter((call) => call.includes('validate'))).toHaveLength(2);
    expect(f.calls.filter((call) => call.includes('test'))).toHaveLength(2);
  });

  it('dry run does not write, execute, or claim completed work', async () => {
    const f = fixture();
    const result = await f.run({ dryRun: true });
    expect(existsSync(f.project)).toBe(false);
    expect(result.setup.completed).toEqual([]);
    expect(result.setup.ready).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('explicit files-only setup never installs or reports verified readiness', async () => {
    const f = fixture();
    const result = await f.run({ install: false });
    expect(existsSync(join(f.project, 'src/server.ts'))).toBe(true);
    expect(result.setup.completed).toEqual(['scaffold']);
    expect(result.setup.ready).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it('refuses conflicting ownership before changing any project files', async () => {
    const f = fixture();
    await f.run({ install: false });
    writeFileSync(join(f.project, 'yarn.lock'), 'customer-owned');
    const before = readFileSync(join(f.project, 'package.json'), 'utf8');
    await expect(f.run({ packageManager: 'npm' })).rejects.toThrow(/package.manager conflict/);
    expect(readFileSync(join(f.project, 'package.json'), 'utf8')).toBe(before);
    expect(f.calls).toEqual([]);
  });

  it('uses the selected package manager consistently', async () => {
    const f = fixture();
    const result = await f.run({ packageManager: 'pnpm' });
    expect(result.setup.ready).toBe(true);
    expect(result.setup.packageManager).toBe('pnpm');
    expect(f.calls.filter((call) => call[0] === 'pnpm').map((call) => call[1])).toEqual([
      '--version',
      'install',
      'run',
      'run',
    ]);
  });

  it('preserves Yarn ownership and reports its unsupported bundled install without switching managers', async () => {
    const f = fixture();
    const result = await f.run({ packageManager: 'yarn' });
    expect(result.setup.failed).toEqual({ stage: 'install', code: 'package_manager_unsupported' });
    expect(result.setup.nextSteps[0]?.reason).toContain('bundled');
    expect(f.calls).toEqual([]);
    expect(existsSync(join(f.project, 'package-lock.json'))).toBe(false);
    expect((await f.run({ packageManager: 'yarn', install: false })).setup.ready).toBe(false);
  });

  it('records context failure without executing application checks or leaking resolver errors', async () => {
    const f = fixture();
    const context = vi.fn(async () => {
      throw new Error('secret-context-error');
    });
    const result = await bootstrapProject(
      { dir: f.project, template: 'hello', agentTargets: ['codex'], install: false },
      { env: {}, setupContext: context },
    );
    expect(result.setup.failed).toEqual({ stage: 'context', code: 'context_invalid' });
    expect(JSON.stringify(result)).not.toContain('secret-context-error');
    expect(result.setup.restartRequired).toBe(true);
  });

  it.each([
    'not-json',
    '{"ok":false}',
    '{}',
  ])('rejects zero-exit invalid validation output: %s', async (stdout) => {
    const f = fixture();
    const result = await bootstrapProject(
      { dir: f.project, template: 'hello', agentTargets: [] },
      {
        env: {},
        execute: async (command, args, options) =>
          args.includes('validate') ? { ok: true, stdout } : f.execute(command, args, options),
      },
    );
    expect(result.setup.failed).toEqual({ stage: 'validate', code: 'verification_failed' });
    expect(result.setup.ready).toBe(false);
    expect(f.calls.flat()).not.toContain('test');
  });

  it('files-only reconciliation does not destroy an earlier verification checkpoint', async () => {
    const f = fixture();
    await f.run();
    const before = readFileSync(join(f.project, '.noodle/setup.json'), 'utf8');
    const result = await f.run({ install: false });
    expect(result.setup.ready).toBe(false);
    expect(readFileSync(join(f.project, '.noodle/setup.json'), 'utf8')).toBe(before);
  });

  it('preserves an older SDK pin and asks for an explicit upgrade instead of rewriting it', async () => {
    const f = fixture();
    await f.run({ install: false });
    const path = join(f.project, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.devDependencies['@noodleseed/one'] = '0.1.0';
    writeFileSync(path, JSON.stringify(manifest));
    const before = readFileSync(path, 'utf8');
    const result = await f.run();
    expect(result.setup.failed?.code).toBe('dependency_mismatch');
    expect(result.setup.nextSteps[0]?.reason).toContain('explicitly review an SDK upgrade');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(f.calls).toEqual([]);
  });

  it('retries explicit launch after failure, never reruns a completed launch, and verifies first', async () => {
    const f = fixture();
    const launchAgent = vi.fn<typeof launchBootstrapAgent>(async () => ({ ok: true }));
    launchAgent.mockResolvedValueOnce({ ok: false, code: 'missing_executable' });
    const run = () =>
      bootstrapProject(
        {
          dir: f.project,
          template: 'hello',
          agentTargets: ['codex'],
          launch: 'codex',
          docsMcp: false,
        },
        {
          env: {},
          execute: f.execute,
          interactive: true,
          launchAgent,
          setupContext: async () => ({
            ok: true,
            dryRun: false,
            project: f.project,
            targets: ['codex'],
            files: [],
            restartHints: [],
          }),
        },
      );
    const first = await run();
    expect(first.setup.failed).toEqual({ stage: 'launch', code: 'missing_executable' });
    expect(first.setup.completed).toContain('types');
    expect(first.setup.resumeCommand).toContain('--launch codex');
    expect((await run()).setup.restartRequired).toBe(false);
    expect((await run()).setup.ready).toBe(true);
    expect(launchAgent).toHaveBeenCalledTimes(2);
    expect(f.calls.filter((call) => call.includes('typecheck'))).toHaveLength(3);
  });

  it('rejects noninteractive launch before scaffolding or running any command', async () => {
    const f = fixture();
    await expect(f.run({ agentTargets: ['codex'], launch: 'codex' })).rejects.toThrow(
      /interactive terminal/,
    );
    expect(existsSync(f.project)).toBe(false);
    expect(f.calls).toEqual([]);
  });
});

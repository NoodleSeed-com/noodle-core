import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderPluginLauncher } from '../src/plugin-launcher.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createLauncherFixture(
  host: 'claude-code' | 'codex' | 'copilot' | 'cursor',
  launcherPath: string,
) {
  const root = await mkdtemp(join(tmpdir(), `noodle ${host} launcher `));
  roots.push(root);
  const home = join(root, 'home');
  const fakeBin = join(root, 'bin');
  const output = join(root, 'invocation.json');
  await Promise.all([mkdir(home, { recursive: true }), mkdir(fakeBin, { recursive: true })]);
  const launcher = join(root, launcherPath);
  await mkdir(dirname(launcher), { recursive: true });
  await writeFile(launcher, renderPluginLauncher({ host, cliVersion: '4.5.6' }), 'utf8');
  await writeFile(join(root, 'noodle-plugin-compatibility.json'), '{}\n', 'utf8');
  const fakeNpm = join(fakeBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  if (process.platform === 'win32') {
    await writeFile(
      fakeNpm,
      `@"${process.execPath}" "${join(fakeBin, 'fake-npm.mjs')}" %*\r\n`,
      'utf8',
    );
  } else {
    await writeFile(
      fakeNpm,
      `#!/bin/sh\nexec "${process.execPath}" "${join(fakeBin, 'fake-npm.mjs')}" "$@"\n`,
      'utf8',
    );
    await chmod(fakeNpm, 0o755);
  }
  await writeFile(
    join(fakeBin, 'fake-npm.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.FAKE_NPM_OUTPUT, JSON.stringify({',
      '  argv: process.argv.slice(2),',
      '  host: process.env.NOODLE_PLUGIN_HOST,',
      '  configHome: process.env.NOODLE_CONFIG_HOME,',
      '  compatibilityFile: process.env.NOODLE_PLUGIN_COMPATIBILITY_FILE,',
      '}));',
      'if (process.env.FAKE_NPM_STDERR) process.stderr.write(process.env.FAKE_NPM_STDERR);',
      'process.exit(Number(process.env.FAKE_NPM_EXIT));',
    ].join('\n'),
    'utf8',
  );
  return { root, home, fakeBin, output, launcher };
}

function executeGeneratedLauncher(
  host: 'claude-code' | 'codex' | 'copilot' | 'cursor',
  argv: readonly string[],
) {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
  const spawn = vi.fn(() => child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtimeProcess = {
    argv: [process.execPath, 'C:\\Users\\Bilal\\Plugin Cache\\noodle-plugin.mjs', ...argv],
    env: {},
    execPath: process.execPath,
    exitCode: undefined as number | undefined,
    kill: vi.fn(),
    pid: 1234,
    platform: 'win32',
    stderr: { write: (value: unknown) => stderr.push(String(value)) },
    stdout: { write: (value: unknown) => stdout.push(String(value)) },
  };
  const source = renderPluginLauncher({ host, cliVersion: '4.5.6' })
    .replace(/^#!.*\n/, '')
    .replace(/^import .*;\n/gm, '')
    .replaceAll('import.meta.url', "'file:///noodle-plugin.mjs'");

  runInNewContext(source, {
    dirname,
    fileURLToPath,
    homedir: () => 'C:\\Users\\Bilal',
    join,
    process: runtimeProcess,
    resolve,
    spawn,
  });

  return {
    exitCode: runtimeProcess.exitCode,
    spawn,
    stderr: stderr.join(''),
    stdout: stdout.join(''),
  };
}

describe('plugin-managed CLI launcher', () => {
  it.each([
    'claude-code',
    'codex',
    'copilot',
    'cursor',
  ] as const)('rejects native Windows before spawning the %s bootstrap', (host) => {
    const result = executeGeneratedLauncher(host, ['plugin-mcp', '--json']);

    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: 'unsupported_platform',
        message: 'Noodle CLI commands run on macOS or Windows through WSL2.',
        cause: 'Native PowerShell, Command Prompt, and Git Bash are not supported.',
        fix: 'Install WSL2 with Ubuntu and run Noodle from its Bash shell.',
        next: 'wsl --install -d Ubuntu',
      },
    });
    expect(`${result.stdout}${result.stderr}`).not.toContain('Plugin Cache');
  });

  it('prints the native Windows WSL2 handoff without starting npm', () => {
    const result = executeGeneratedLauncher('codex', ['plugin-mcp']);

    expect(result.spawn).not.toHaveBeenCalled();
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'unsupported_platform: Noodle CLI commands run on macOS or Windows through WSL2.',
    );
    expect(result.stderr).toContain('Next: wsl --install -d Ubuntu');
    expect(result.stderr).not.toContain('Plugin Cache');
  });

  it.each([
    'claude-code',
    'codex',
    'copilot',
    'cursor',
  ] as const)('pins the exact CLI package and never resolves latest for %s', (host) => {
    const source = renderPluginLauncher({ host, cliVersion: '4.5.6' });
    expect(source).toContain('@noodleseed/one@4.5.6');
    expect(source).not.toContain('@latest');
    expect(source).not.toContain('npm.cmd');
    expect(source).toContain('process.execPath');
    expect(source).toContain("'node_modules', 'npm', 'bin', 'npm-cli.js'");
    expect(source).toContain('shell: false');
    expect(source).toContain(`NOODLE_PLUGIN_HOST: '${host}'`);
  });

  it.each([
    ['claude-code', 'bin/noodle-plugin.mjs'],
    ['codex', 'skills/noodle-seed/scripts/noodle-plugin.mjs'],
    ['copilot', 'skills/noodle-seed/scripts/noodle-plugin.mjs'],
    ['cursor', 'skills/noodle-seed/scripts/noodle-plugin-cursor.mjs'],
  ] as const)('executes %s with isolated profile state and byte-preserved argv', async (host, launcherPath) => {
    const { root, home, fakeBin, output, launcher } = await createLauncherFixture(
      host,
      launcherPath,
    );
    expect(root).toContain(' ');

    const result = spawnSync(
      process.execPath,
      [launcher, 'init', 'argument with spaces', 'line one\nline two'],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
          FAKE_NPM_OUTPUT: output,
          FAKE_NPM_EXIT: '23',
          FAKE_NPM_STDERR: 'validation failed at tools.search.input\\n',
        },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(23);
    expect(result.stderr).toBe('validation failed at tools.search.input\\n');
    expect(result.stderr).not.toContain('plugin_cli_bootstrap_failed');
    const invocation = JSON.parse(await readFile(output, 'utf8'));
    expect(invocation.argv).toEqual([
      'exec',
      '--yes',
      '--package=@noodleseed/one@4.5.6',
      '--',
      'noodle',
      'init',
      'argument with spaces',
      'line one\nline two',
    ]);
    expect(invocation.host).toBe(host);
    expect(invocation.configHome).toBe(join(home, '.noodle', 'plugin-profiles', host));
    expect(invocation.compatibilityFile).toBe(
      join(await realpath(root), 'noodle-plugin-compatibility.json'),
    );
  });

  it('adds structured recovery after an npm bootstrap failure without hiding the raw diagnostic', async () => {
    const { home, fakeBin, output, launcher } = await createLauncherFixture(
      'codex',
      'skills/noodle-seed/scripts/noodle-plugin.mjs',
    );
    const rawDiagnostic = 'npm error code EAI_AGAIN\nnpm error network request failed\n';
    const result = spawnSync(process.execPath, [launcher, 'validate', '--json'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_NPM_OUTPUT: output,
        FAKE_NPM_EXIT: '1',
        FAKE_NPM_STDERR: rawDiagnostic,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr.startsWith(rawDiagnostic)).toBe(true);
    const recovery = JSON.parse(result.stderr.slice(rawDiagnostic.length).trim());
    expect(recovery).toEqual({
      ok: false,
      error: {
        code: 'plugin_cli_bootstrap_failed',
        message: 'The plugin could not start its pinned CLI package @noodleseed/one@4.5.6.',
        next: [
          'Check access to https://registry.npmjs.org and retry.',
          'Update or reinstall the Noodle Seed plugin from its marketplace.',
          'If it continues, verify npm can resolve @noodleseed/one@4.5.6.',
        ],
      },
    });
  });

  it('detects an early bootstrap diagnostic while keeping captured stderr bounded', async () => {
    const { home, fakeBin, output, launcher } = await createLauncherFixture(
      'claude-code',
      'bin/noodle-plugin.mjs',
    );
    const rawDiagnostic = `npm error code ENOTFOUND\n${'x'.repeat(20 * 1024)}\n`;
    const result = spawnSync(process.execPath, [launcher, 'init'], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        FAKE_NPM_OUTPUT: output,
        FAKE_NPM_EXIT: '1',
        FAKE_NPM_STDERR: rawDiagnostic,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr.startsWith(rawDiagnostic)).toBe(true);
    const recovery = JSON.parse(result.stderr.slice(rawDiagnostic.length).trim());
    expect(recovery.error.code).toBe('plugin_cli_bootstrap_failed');
    expect(JSON.stringify(recovery).length).toBeLessThan(1024);
  });

  it('uses distinct fixed profile roots and propagates child signals', () => {
    const claude = renderPluginLauncher({ host: 'claude-code', cliVersion: '1.0.0' });
    const codex = renderPluginLauncher({ host: 'codex', cliVersion: '1.0.0' });
    const copilot = renderPluginLauncher({ host: 'copilot', cliVersion: '1.0.0' });
    const cursor = renderPluginLauncher({ host: 'cursor', cliVersion: '1.0.0' });
    expect(claude).toContain("'claude-code'");
    expect(codex).toContain("'codex'");
    expect(copilot).toContain("'copilot'");
    expect(cursor).toContain("'cursor'");
    expect(claude).toContain('process.kill(process.pid, signal)');
    expect(codex).toContain('process.kill(process.pid, signal)');
    expect(copilot).toContain('process.kill(process.pid, signal)');
    expect(cursor).toContain('process.kill(process.pid, signal)');
  });
});

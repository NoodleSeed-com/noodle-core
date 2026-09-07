import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  PUBLIC_VERIFICATION_STAGES,
  PublicVerificationFailure,
  runPublicVerification,
} from '../../../scripts/verify-public-repository.mjs';

describe('canonical public repository verification graph', () => {
  it('runs one ordered graph and keeps the real self-host journey after static validation', () => {
    expect(PUBLIC_VERIFICATION_STAGES).toEqual([
      {
        name: 'install',
        command: 'pnpm',
        args: ['install', '--frozen-lockfile', '--ignore-scripts'],
      },
      {
        name: 'browser',
        command: 'pnpm',
        args: ['exec', 'playwright', 'install', 'chromium'],
      },
      { name: 'lint', command: 'pnpm', args: ['lint'] },
      { name: 'build', command: 'pnpm', args: ['build'] },
      { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
      { name: 'test', command: 'pnpm', args: ['test'] },
      { name: 'package-boundary', command: 'pnpm', args: ['package-boundary-gate'] },
      { name: 'license', command: 'pnpm', args: ['license-gate'] },
      { name: 'size', command: 'pnpm', args: ['size-gate'] },
      { name: 'escape-hatch', command: 'pnpm', args: ['escape-hatch-gate'] },
      { name: 'public-docs', command: 'pnpm', args: ['docs:check'] },
      { name: 'self-host-e2e', command: 'node', args: ['scripts/self-host-e2e.mjs'] },
    ]);
  });

  it('invokes every stage once in order', async () => {
    const run = vi.fn(async () => undefined);

    await expect(runPublicVerification({ root: '/projected', runner: { run } })).resolves.toEqual(
      PUBLIC_VERIFICATION_STAGES.map((stage) => stage.name),
    );
    expect(run.mock.calls.map(([input]) => input)).toEqual(
      PUBLIC_VERIFICATION_STAGES.map((stage) => ({ ...stage, cwd: '/projected' })),
    );
  });

  it('keeps using the caller-provided immutable pnpm after install', async () => {
    const trustedPnpm = '/opt/noodle-oss-verify/bin/pnpm';
    const trustedNode = '/opt/noodle-oss-verify/node/bin/node';
    const trustedDocker = '/opt/noodle-oss-verify/bin/docker';
    const run = vi.fn(async () => undefined);

    await runPublicVerification({
      root: '/projected',
      pnpmPath: trustedPnpm,
      nodePath: trustedNode,
      dockerPath: trustedDocker,
      runner: { run },
    });

    expect(run.mock.calls.map(([input]) => input.command)).toEqual(
      PUBLIC_VERIFICATION_STAGES.map((stage) =>
        stage.command === 'pnpm' ? trustedPnpm : trustedNode,
      ),
    );
    expect(run.mock.calls.at(-1)?.[0].args).toEqual([
      'scripts/self-host-e2e.mjs',
      '--docker',
      trustedDocker,
    ]);
  });

  it('rejects a relative trusted pnpm path', async () => {
    await expect(
      runPublicVerification({
        root: '/projected',
        pnpmPath: 'node_modules/.bin/pnpm',
        runner: { run: vi.fn() },
      }),
    ).rejects.toThrow(/absolute pnpm path/i);
  });

  it('requires an absolute Docker path with a trusted pnpm', async () => {
    await expect(
      runPublicVerification({
        root: '/projected',
        pnpmPath: '/opt/noodle-oss-verify/bin/pnpm',
        dockerPath: 'node_modules/.bin/docker',
        runner: { run: vi.fn() },
      }),
    ).rejects.toThrow(/absolute Docker path/i);
  });

  it('requires an absolute Node path in trusted mode', async () => {
    await expect(
      runPublicVerification({
        root: '/projected',
        pnpmPath: '/opt/noodle-oss-verify/bin/pnpm',
        nodePath: 'node_modules/.bin/node',
        dockerPath: '/opt/noodle-oss-verify/bin/docker',
        runner: { run: vi.fn() },
      }),
    ).rejects.toThrow(/absolute Node path/i);
  });

  it('does not resolve project-planted pnpm or Docker shims after install', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noodle-public-verifier-tools-'));
    const project = join(root, 'project');
    const tools = join(root, 'root-owned-tools');
    const trustedPnpm = join(tools, 'pnpm');
    const trustedNode = join(tools, 'node');
    const trustedDocker = join(tools, 'docker');
    const invocations = join(root, 'invocations.txt');
    const nodeInvocations = join(root, 'node-invocations.txt');
    const plantedDockerInvocations = join(root, 'planted-docker-invocations.txt');
    mkdirSync(project);
    mkdirSync(tools);
    writeFileSync(
      trustedPnpm,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(invocations)}
if [ "$1" = install ]; then
  mkdir -p "$PWD/node_modules/.bin"
  printf '#!/bin/sh\\nexit 97\\n' > "$PWD/node_modules/.bin/pnpm"
  chmod 755 "$PWD/node_modules/.bin/pnpm"
  printf '#!/bin/sh\\nprintf planted >> %s\\nexit 0\\n' ${JSON.stringify(plantedDockerInvocations)} > "$PWD/node_modules/.bin/docker"
  chmod 755 "$PWD/node_modules/.bin/docker"
fi
exit 0
`,
      { mode: 0o555 },
    );
    writeFileSync(
      trustedNode,
      `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(nodeInvocations)}
exit 0
`,
      { mode: 0o555 },
    );
    writeFileSync(trustedDocker, '#!/bin/sh\nexit 0\n', { mode: 0o555 });
    chmodSync(tools, 0o555);

    try {
      await expect(
        runPublicVerification({
          root: project,
          pnpmPath: trustedPnpm,
          nodePath: trustedNode,
          dockerPath: trustedDocker,
        }),
      ).resolves.toEqual(PUBLIC_VERIFICATION_STAGES.map((stage) => stage.name));
      const calls = readFileSync(invocations, 'utf8').trim().split('\n');
      expect(calls).toHaveLength(
        PUBLIC_VERIFICATION_STAGES.filter((stage) => stage.command === 'pnpm').length,
      );
      expect(calls[0]).toBe('install --frozen-lockfile --ignore-scripts');
      expect(readFileSync(nodeInvocations, 'utf8').trim()).toBe(
        `scripts/self-host-e2e.mjs --docker ${trustedDocker}`,
      );
      expect(existsSync(plantedDockerInvocations)).toBe(false);
    } finally {
      chmodSync(tools, 0o755);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(PUBLIC_VERIFICATION_STAGES)('fails fast with the $name stage', async (failed) => {
    const run = vi.fn(async (input: { readonly name: string }) => {
      if (input.name === failed.name) throw new Error('simulated failure');
    });

    await expect(runPublicVerification({ root: '/projected', runner: { run } })).rejects.toEqual(
      new PublicVerificationFailure(failed.name, 'simulated failure'),
    );
    expect(run).toHaveBeenCalledTimes(PUBLIC_VERIFICATION_STAGES.indexOf(failed) + 1);
  });
});

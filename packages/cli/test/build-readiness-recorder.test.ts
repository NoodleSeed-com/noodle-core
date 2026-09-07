import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BuildRunConflictError,
  recordManagedInvocation,
} from '../src/plugin-mode/build-readiness-recorder.js';
import { BuildReadinessStore } from '../src/plugin-mode/build-readiness-store.js';
import type { PluginMode } from '../src/plugin-mode/profile.js';

const roots: string[] = [];
const NOW = new Date('2026-07-18T02:00:00.000Z');

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(): Promise<{
  root: string;
  mode: PluginMode;
  store: BuildReadinessStore;
}> {
  const root = await mkdtemp(join(tmpdir(), 'noodle-readiness-recorder-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'noodle.json'), '{"entry":"src/server.ts"}\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'src/server.ts'), 'export const value = 1;\n');
  const mode: PluginMode = {
    host: 'codex',
    configHome: join(root, '.profile'),
    compatibilityFile: join(root, 'noodle-plugin-compatibility.json'),
  };
  return {
    root,
    mode,
    store: new BuildReadinessStore(join(mode.configHome, 'build-readiness')),
  };
}

describe('managed plugin lifecycle recorder', () => {
  it('never records a successful preflight as a published deployment', async () => {
    const { root, mode, store } = await setup();
    expect(
      await recordManagedInvocation(
        { command: 'deploy', argv: ['preflight', '--json'], cwd: root, pluginMode: mode },
        async () => 0,
      ),
    ).toBe(0);
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    expect(await store.read(resolveWorkspaceIdentity(root).workspaceHandle)).toBeUndefined();
  });

  it('persists running before invocation and succeeds after a zero exit', async () => {
    const { root, mode, store } = await setup();
    let runningObserved = false;
    const code = await recordManagedInvocation(
      { command: 'validate', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
      async () => {
        const files = await import('../src/plugin-mode/build-readiness-fingerprint.js');
        const identity = files.resolveWorkspaceIdentity(root);
        const state = await store.read(identity.workspaceHandle);
        runningObserved = state?.runs.at(-1)?.status === 'running';
        return 0;
      },
    );
    expect(code).toBe(0);
    expect(runningObserved).toBe(true);
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const final = await store.read(resolveWorkspaceIdentity(root).workspaceHandle);
    expect(final?.runs.at(-1)).toMatchObject({ stage: 'validate', status: 'succeeded' });
  });

  it('records a nonzero command as failed without changing its exit code', async () => {
    const { root, mode, store } = await setup();
    expect(
      await recordManagedInvocation(
        { command: 'test', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
        async () => 7,
      ),
    ).toBe(7);
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    expect(
      (await store.read(resolveWorkspaceIdentity(root).workspaceHandle))?.runs.at(-1),
    ).toMatchObject({
      stage: 'test',
      status: 'failed',
    });
  });

  it('records an exception as interrupted and rethrows it', async () => {
    const { root, mode, store } = await setup();
    await expect(
      recordManagedInvocation(
        { command: 'check', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
        async () => {
          throw new Error('process disappeared');
        },
      ),
    ).rejects.toThrow('process disappeared');
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    expect(
      (await store.read(resolveWorkspaceIdentity(root).workspaceHandle))?.runs.at(-1),
    ).toMatchObject({
      stage: 'target-check',
      status: 'interrupted',
    });
  });

  it('does not record unrelated CLI commands', async () => {
    const { root, mode, store } = await setup();
    expect(
      await recordManagedInvocation(
        { command: 'commands', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
        async () => 0,
      ),
    ).toBe(0);
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    expect(await store.read(resolveWorkspaceIdentity(root).workspaceHandle)).toBeUndefined();
  });

  it('rejects a second lifecycle mutation while one is active', async () => {
    const { root, mode } = await setup();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = recordManagedInvocation(
      { command: 'validate', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
      async () => {
        signalStarted();
        await gate;
        return 0;
      },
    );
    await started;
    try {
      await expect(
        recordManagedInvocation(
          { command: 'test', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
          async () => 0,
        ),
      ).rejects.toBeInstanceOf(BuildRunConflictError);
    } finally {
      release();
    }
    await expect(first).resolves.toBe(0);
  });

  it('interrupts an expired lifecycle run before recording the next invocation', async () => {
    const { root, mode, store } = await setup();
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const identity = resolveWorkspaceIdentity(root);
    await store.write({
      schemaVersion: 1,
      ...identity,
      updatedAt: '2026-07-18T01:58:00.000Z',
      runs: [
        {
          runId: 'run_abcdefghijklmnopqrstuv',
          stage: 'validate',
          status: 'running',
          startedAt: '2026-07-18T01:58:00.000Z',
          heartbeatAt: '2026-07-18T01:58:00.000Z',
        },
      ],
    });

    await expect(
      recordManagedInvocation(
        { command: 'test', argv: ['--json'], cwd: root, pluginMode: mode, now: () => NOW },
        async () => 0,
      ),
    ).resolves.toBe(0);

    const runs = (await store.read(identity.workspaceHandle))?.runs ?? [];
    expect(runs[0]).toMatchObject({
      runId: 'run_abcdefghijklmnopqrstuv',
      status: 'interrupted',
      finishedAt: NOW.toISOString(),
    });
    expect(runs[1]).toMatchObject({ stage: 'test', status: 'succeeded' });
  });

  it('evaluates expiry with a fresh timestamp after fingerprinting', async () => {
    const { root, mode, store } = await setup();
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const identity = resolveWorkspaceIdentity(root);
    await store.write({
      schemaVersion: 1,
      ...identity,
      updatedAt: '2026-07-18T01:59:40.000Z',
      runs: [
        {
          runId: 'run_abcdefghijklmnopqrstuv',
          stage: 'validate',
          status: 'running',
          startedAt: '2026-07-18T01:59:40.000Z',
          heartbeatAt: '2026-07-18T01:59:40.000Z',
        },
      ],
    });
    let tick = 0;
    const now = () => new Date(NOW.getTime() + Math.min(tick++, 1) * 20_000);

    await expect(
      recordManagedInvocation(
        { command: 'test', argv: ['--json'], cwd: root, pluginMode: mode, now },
        async () => 0,
      ),
    ).resolves.toBe(0);

    const runs = (await store.read(identity.workspaceHandle))?.runs ?? [];
    expect(runs[0]).toMatchObject({
      runId: 'run_abcdefghijklmnopqrstuv',
      status: 'interrupted',
      finishedAt: '2026-07-18T02:00:20.000Z',
    });
    expect(runs[1]).toMatchObject({
      stage: 'test',
      status: 'succeeded',
      startedAt: NOW.toISOString(),
    });
  });

  it('refreshes the heartbeat while a managed command is running', async () => {
    const { root, mode, store } = await setup();
    let tick = 0;
    const now = () => new Date(NOW.getTime() + tick++ * 1_000);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const invocation = recordManagedInvocation(
      { command: 'validate', argv: [], cwd: root, pluginMode: mode, now, heartbeatMs: 5 },
      async () => {
        signalStarted();
        await gate;
        return 0;
      },
    );
    await started;
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const handle = resolveWorkspaceIdentity(root).workspaceHandle;
    try {
      await expect
        .poll(
          async () => {
            const active = await store.read(handle);
            expect(active?.runs.at(-1)).toMatchObject({ status: 'running' });
            return new Date(active?.runs.at(-1)?.heartbeatAt ?? 0).getTime();
          },
          { interval: 5, timeout: 1_000 },
        )
        .toBeGreaterThan(NOW.getTime() + 1_000);
    } finally {
      release();
    }
    await expect(invocation).resolves.toBe(0);
  });

  it('binds later evidence to a new fingerprint after source changes', async () => {
    const { root, mode, store } = await setup();
    await recordManagedInvocation(
      { command: 'validate', argv: [], cwd: root, pluginMode: mode, now: () => NOW },
      async () => 0,
    );
    await writeFile(join(root, 'src/server.ts'), 'export const value = 2;\n');
    await recordManagedInvocation(
      { command: 'test', argv: [], cwd: root, pluginMode: mode, now: () => NOW },
      async () => 0,
    );
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const runs = (await store.read(resolveWorkspaceIdentity(root).workspaceHandle))?.runs ?? [];
    expect(runs[0]?.sourceFingerprint).not.toBe(runs[1]?.sourceFingerprint);
  });

  it('resolves an init destination after options that consume values', async () => {
    const { root, mode, store } = await setup();
    await recordManagedInvocation(
      {
        command: 'init',
        argv: ['--template', 'hello', '--name', 'sample', 'new-app', '--json'],
        cwd: root,
        pluginMode: mode,
        now: () => NOW,
      },
      async () => 0,
    );
    const { resolveWorkspaceIdentity } = await import(
      '../src/plugin-mode/build-readiness-fingerprint.js'
    );
    const expected = resolveWorkspaceIdentity(join(root, 'new-app'));
    expect((await store.read(expected.workspaceHandle))?.workspaceDigest).toBe(
      expected.workspaceDigest,
    );
  });
});

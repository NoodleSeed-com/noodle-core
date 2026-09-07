import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BuildReadinessSnapshot } from '../src/plugin-mode/build-readiness-contract.js';
import {
  fingerprintAuthoringInputs,
  resolveWorkspaceIdentity,
} from '../src/plugin-mode/build-readiness-fingerprint.js';
import {
  BuildReadinessStore,
  BuildReadinessStoreLockError,
} from '../src/plugin-mode/build-readiness-store.js';

const roots: string[] = [];
const NOW = '2026-07-18T02:00:00.000Z';

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'noodle-readiness-store-'));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'test'), { recursive: true });
  await writeFile(join(root, 'noodle.json'), '{"entry":"src/server.ts"}\n');
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'src/server.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'test/server.test.ts'), 'export const testValue = 1;\n');
  return root;
}

function snapshot(root: string): BuildReadinessSnapshot {
  const identity = resolveWorkspaceIdentity(root);
  return {
    schemaVersion: 1,
    ...identity,
    updatedAt: NOW,
    runs: [],
  };
}

describe('build readiness workspace identity and fingerprint', () => {
  it('returns stable opaque identities without disclosing the workspace path', async () => {
    const root = await project();
    const first = resolveWorkspaceIdentity(root);
    expect(resolveWorkspaceIdentity(root)).toEqual(first);
    expect(first.workspaceHandle).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(first.workspaceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(root);
  });

  it('changes when authoring source or tests change', async () => {
    const root = await project();
    const first = await fingerprintAuthoringInputs(root);
    await writeFile(join(root, 'src/server.ts'), 'export const value = 2;\n');
    const sourceChanged = await fingerprintAuthoringInputs(root);
    await writeFile(join(root, 'test/server.test.ts'), 'export const testValue = 2;\n');
    const testChanged = await fingerprintAuthoringInputs(root);
    expect(sourceChanged).not.toBe(first);
    expect(testChanged).not.toBe(sourceChanged);
  });

  it('ignores caches, generated output, plugin state, and managed secret files', async () => {
    const root = await project();
    const first = await fingerprintAuthoringInputs(root);
    for (const directory of ['node_modules/pkg', '.git/objects', '.noodle/state', 'dist/assets']) {
      await mkdir(join(root, directory), { recursive: true });
      await writeFile(join(root, directory, 'ignored.ts'), 'changed');
    }
    await writeFile(join(root, '.env.noodle'), 'SECRET=value\n');
    expect(await fingerprintAuthoringInputs(root)).toBe(first);
  });

  it('rejects a symlinked authoring input instead of following it', async () => {
    const root = await project();
    const outside = await mkdtemp(join(tmpdir(), 'noodle-readiness-outside-'));
    roots.push(outside);
    await writeFile(join(outside, 'outside.ts'), 'export const secret = true;\n');
    await symlink(join(outside, 'outside.ts'), join(root, 'src/linked.ts'));
    await expect(fingerprintAuthoringInputs(root)).rejects.toThrow(/symbolic link/i);
  });
});

describe('build readiness store', () => {
  it('writes owner-only state atomically and reads it through strict validation', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile', 'build-readiness');
    const store = new BuildReadinessStore(storeRoot);
    const value = snapshot(root);
    await store.write(value);
    expect(await store.read(value.workspaceHandle)).toEqual(value);
    expect((await stat(storeRoot)).mode & 0o077).toBe(0);
    expect((await stat(store.pathFor(value.workspaceHandle))).mode & 0o077).toBe(0);
    expect(await readdir(storeRoot)).toEqual([`${value.workspaceHandle}.json`]);
  });

  it('serializes concurrent mutations without losing either update', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile');
    const store = new BuildReadinessStore(storeRoot);
    const initial = snapshot(root);
    await store.write(initial);
    await Promise.all(
      ['first', 'second'].map((code) =>
        store.mutate(initial.workspaceHandle, (current) => ({
          ...(current ?? initial),
          findings: [
            ...(current?.findings ?? []),
            { code, severity: 'info', message: `${code} finding` },
          ],
        })),
      ),
    );
    expect(
      (await store.read(initial.workspaceHandle))?.findings?.map(({ code }) => code).sort(),
    ).toEqual(['first', 'second']);
  });

  it('rejects a mutation from a second store while the workspace lock is held', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile');
    const firstStore = new BuildReadinessStore(storeRoot);
    const secondStore = new BuildReadinessStore(storeRoot);
    const initial = snapshot(root);
    await firstStore.write(initial);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const first = firstStore.mutate(initial.workspaceHandle, async (current) => {
      signalStarted();
      await gate;
      return current ?? initial;
    });
    await started;
    try {
      await expect(
        secondStore.mutate(initial.workspaceHandle, (current) => current ?? initial),
      ).rejects.toBeInstanceOf(BuildReadinessStoreLockError);
    } finally {
      release();
    }
    await expect(first).resolves.toEqual(initial);
  });

  it('recovers a lock whose owning process no longer exists', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile');
    const store = new BuildReadinessStore(storeRoot);
    const initial = snapshot(root);
    await store.write(initial);
    await writeFile(
      join(storeRoot, `${initial.workspaceHandle}.lock`),
      `${JSON.stringify({ token: 'dead', pid: 2_147_483_647, createdAt: NOW })}\n`,
      { mode: 0o600 },
    );
    await expect(
      store.mutate(initial.workspaceHandle, (current) => current ?? initial),
    ).resolves.toEqual(initial);
    expect((await readdir(storeRoot)).some((name) => name.includes('.lock.stale-'))).toBe(true);
  });

  it('marks an expired active heartbeat interrupted without changing recent runs', async () => {
    const root = await project();
    const store = new BuildReadinessStore(join(root, '.profile'));
    const initial = snapshot(root);
    await store.write({
      ...initial,
      runs: [
        {
          runId: 'run_abcdefghijklmnopqrstuv',
          stage: 'validate',
          status: 'running',
          startedAt: '2026-07-18T01:58:00.000Z',
          heartbeatAt: '2026-07-18T01:59:00.000Z',
        },
        {
          runId: 'run_bcdefghijklmnopqrstuvw',
          stage: 'test',
          status: 'running',
          startedAt: '2026-07-18T01:59:55.000Z',
          heartbeatAt: '2026-07-18T01:59:59.000Z',
        },
      ],
    });
    const recovered = await store.interruptExpiredRuns(
      initial.workspaceHandle,
      new Date(NOW),
      30_000,
    );
    expect(recovered?.runs[0]).toMatchObject({
      status: 'interrupted',
      heartbeatAt: NOW,
      finishedAt: NOW,
    });
    expect(recovered?.runs[1]).toMatchObject({ status: 'running' });
    expect(recovered?.runs[1]).not.toHaveProperty('finishedAt');
  });

  it('reads a recent active run without contending on its workspace write lock', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile');
    const store = new BuildReadinessStore(storeRoot);
    const statusStore = new BuildReadinessStore(storeRoot);
    const initial = snapshot(root);
    await store.write({
      ...initial,
      runs: [
        {
          runId: 'run_abcdefghijklmnopqrstuv',
          stage: 'validate',
          status: 'running',
          startedAt: NOW,
          heartbeatAt: NOW,
        },
      ],
    });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const mutation = store.mutate(initial.workspaceHandle, async (current) => {
      signalStarted();
      await gate;
      if (current === undefined) throw new Error('expected state');
      return current;
    });
    await started;
    let status: BuildReadinessSnapshot | undefined;
    try {
      status = await statusStore.interruptExpiredRuns(
        initial.workspaceHandle,
        new Date(NOW),
        30_000,
      );
    } finally {
      release();
      await mutation;
    }
    expect(status).toMatchObject({ runs: [{ status: 'running' }] });
  });

  it('quarantines corrupt state and never infers a successful snapshot', async () => {
    const root = await project();
    const storeRoot = join(root, '.profile');
    const store = new BuildReadinessStore(storeRoot);
    const value = snapshot(root);
    await mkdir(storeRoot, { recursive: true });
    await writeFile(store.pathFor(value.workspaceHandle), '{broken', { mode: 0o600 });
    expect(await store.read(value.workspaceHandle)).toBeUndefined();
    expect((await readdir(storeRoot)).some((name) => name.includes('.corrupt-'))).toBe(true);
  });

  it('rejects sensitive values before they reach disk', async () => {
    const root = await project();
    const store = new BuildReadinessStore(join(root, '.profile'));
    const value = snapshot(root);
    await expect(
      store.write({
        ...value,
        findings: [
          {
            code: 'unsafe',
            severity: 'error',
            message: 'Authorization: Bearer should-not-persist',
          },
        ],
      }),
    ).rejects.toThrow(/sensitive|secret/i);
    await expect(readFile(store.pathFor(value.workspaceHandle), 'utf8')).rejects.toThrow();
  });
});

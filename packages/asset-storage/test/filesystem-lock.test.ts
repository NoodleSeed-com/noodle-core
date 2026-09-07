import { link, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type FilesystemAssetLockGuard,
  type FilesystemAssetLockRuntime,
  withFilesystemAssetLock,
} from '../src/filesystem-coordination.js';
import {
  FilesystemAssetSecurityError,
  filesystemAssetStateDirectory,
  prepareFilesystemAssetLayout,
} from '../src/filesystem-layout.js';

const OLD_INSTANCE = 'a'.repeat(32);
const NEW_INSTANCE = 'b'.repeat(32);
const OWNER_NONCE = 'c'.repeat(32);

async function root(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'noodle-fs-lock-')));
}

function record(pid: number, processInstanceId: string, leaseExpiresAt: number): string {
  return `${JSON.stringify({
    version: 2,
    pid,
    processInstanceId,
    nonce: OWNER_NONCE,
    leaseExpiresAt: String(leaseExpiresAt).padStart(16, '0'),
  })}\n`;
}

function runtime(overrides: Partial<FilesystemAssetLockRuntime> = {}): FilesystemAssetLockRuntime {
  return {
    pid: 42,
    processInstanceId: NEW_INSTANCE,
    now: () => 2_000,
    isProcessLive: () => false,
    wait: async () => undefined,
    leaseMs: 300,
    heartbeatMs: 100,
    ...overrides,
  };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('condition was not reached');
}

describe('filesystem asset lock leases', () => {
  it('releases the same-root process queue after a callback failure', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withFilesystemAssetLock(storageRoot, anchor, async () => {
      order.push('first');
      firstEntered();
      await firstGate;
      throw new Error('expected callback failure');
    });
    const firstOutcome = expect(first).rejects.toThrow('expected callback failure');
    await entered;
    const second = withFilesystemAssetLock(storageRoot, anchor, async () => {
      order.push('second');
    });
    releaseFirst();

    await firstOutcome;
    await second;
    await withFilesystemAssetLock(storageRoot, anchor, async () => {
      order.push('third');
    });

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('keeps process queues independent across canonical roots', async () => {
    const firstRoot = await root();
    const secondRoot = await root();
    const firstAnchor = await prepareFilesystemAssetLayout(firstRoot);
    const secondAnchor = await prepareFilesystemAssetLayout(secondRoot);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withFilesystemAssetLock(firstRoot, firstAnchor, async () => {
      firstEntered();
      await firstGate;
    });
    await entered;

    let secondEntered = false;
    await withFilesystemAssetLock(secondRoot, secondAnchor, async () => {
      secondEntered = true;
    });
    expect(secondEntered).toBe(true);

    releaseFirst();
    await first;
  });

  it('recovers a crashed owner after its bounded lease', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const lockPath = join(filesystemAssetStateDirectory(storageRoot), 'coordination.lock');
    await writeFile(lockPath, record(7, OLD_INSTANCE, 1_000), { mode: 0o600 });
    let entered = false;

    await withFilesystemAssetLock(
      storageRoot,
      anchor,
      async () => {
        entered = true;
      },
      runtime({ now: () => 1_001, isProcessLive: () => false }),
    );

    expect(entered).toBe(true);
  });

  it('waits out an unexpired lease before recovering a reused PID from another process instance', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const lockPath = join(filesystemAssetStateDirectory(storageRoot), 'coordination.lock');
    await writeFile(lockPath, record(1, OLD_INSTANCE, 1_100), { mode: 0o600 });
    let now = 1_000;
    let waits = 0;

    await withFilesystemAssetLock(
      storageRoot,
      anchor,
      async () => undefined,
      runtime({
        pid: 1,
        processInstanceId: NEW_INSTANCE,
        now: () => now,
        isProcessLive: () => true,
        wait: async (milliseconds) => {
          waits += 1;
          now += milliseconds;
        },
      }),
    );

    expect(waits).toBeGreaterThan(0);
    expect(now).toBeGreaterThanOrEqual(1_100);
  });

  it('renews a live holder lease and keeps a contender out until release', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const lockPath = join(filesystemAssetStateDirectory(storageRoot), 'coordination.lock');
    let now = 1_000;
    const holderWaits: Array<() => void> = [];
    const contenderWaits: Array<() => void> = [];
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderEntered = false;
    let contenderEntered = false;
    let holderFailure: unknown;
    const holder = withFilesystemAssetLock(
      storageRoot,
      anchor,
      async () => {
        holderEntered = true;
        await holderGate;
      },
      runtime({
        pid: 11,
        processInstanceId: OLD_INSTANCE,
        now: () => now,
        isProcessLive: () => true,
        wait: () => new Promise<void>((resolve) => holderWaits.push(resolve)),
      }),
    );
    void holder.catch((error: unknown) => {
      holderFailure = error;
    });
    await waitUntil(() => holderEntered && holderWaits.length > 0);
    const initial = JSON.parse(await readFile(lockPath, 'utf8')) as { leaseExpiresAt: string };
    now += 100;
    holderWaits.shift()?.();
    await waitUntil(async () => {
      if (holderFailure !== undefined) throw holderFailure;
      const renewed = JSON.parse(await readFile(lockPath, 'utf8')) as { leaseExpiresAt: string };
      return renewed.leaseExpiresAt > initial.leaseExpiresAt;
    });
    now = Number(initial.leaseExpiresAt) + 1;

    const contender = withFilesystemAssetLock(
      storageRoot,
      anchor,
      async () => {
        contenderEntered = true;
      },
      runtime({
        pid: 12,
        processInstanceId: NEW_INSTANCE,
        now: () => now,
        isProcessLive: () => true,
        wait: () => new Promise<void>((resolve) => contenderWaits.push(resolve)),
      }),
    );
    await waitUntil(() => contenderEntered || contenderWaits.length > 0);
    expect(contenderEntered).toBe(false);

    releaseHolder();
    await holder;
    contenderWaits.shift()?.();
    await contender;
    expect(contenderEntered).toBe(true);
  });

  it('finishes an interrupted expired recovery claim without touching a replacement lock', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const state = filesystemAssetStateDirectory(storageRoot);
    const lockPath = join(state, 'coordination.lock');
    await writeFile(lockPath, record(7, OLD_INSTANCE, 1_000), { mode: 0o600 });
    await link(lockPath, join(state, 'coordination.recovery'));
    await unlink(lockPath);
    await writeFile(lockPath, record(8, NEW_INSTANCE, 1_100), { mode: 0o600 });
    let now = 1_001;
    let waits = 0;
    let entered = false;

    await withFilesystemAssetLock(
      storageRoot,
      anchor,
      async () => {
        entered = true;
      },
      runtime({
        now: () => now,
        isProcessLive: () => true,
        wait: async (milliseconds) => {
          waits += 1;
          now += milliseconds;
        },
      }),
    );

    expect(entered).toBe(true);
    expect(waits).toBeGreaterThan(0);
  });

  it('fences a shared mutation after the holder lease expires', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const markerPath = join(filesystemAssetStateDirectory(storageRoot), 'lease-mutation');
    let now = 1_000;
    let entered!: () => void;
    const actionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const holder = withFilesystemAssetLock(
      storageRoot,
      anchor,
      async (guard?: FilesystemAssetLockGuard) => {
        entered();
        await resumed;
        await guard?.assertOwned();
        await writeFile(markerPath, 'mutated\n', { mode: 0o600 });
      },
      runtime({
        pid: 11,
        processInstanceId: OLD_INSTANCE,
        now: () => now,
        isProcessLive: () => true,
        wait: () => new Promise<void>(() => undefined),
      }),
    );
    await actionEntered;
    now = 1_301;
    resume();

    await expect(holder).rejects.toBeInstanceOf(FilesystemAssetSecurityError);
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fences a shared mutation after the lock path is replaced', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    const state = filesystemAssetStateDirectory(storageRoot);
    const lockPath = join(state, 'coordination.lock');
    const markerPath = join(state, 'replacement-mutation');
    let entered!: () => void;
    const actionEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const holder = withFilesystemAssetLock(
      storageRoot,
      anchor,
      async (guard?: FilesystemAssetLockGuard) => {
        entered();
        await resumed;
        await guard?.assertOwned();
        await writeFile(markerPath, 'mutated\n', { mode: 0o600 });
      },
      runtime({
        pid: 11,
        processInstanceId: OLD_INSTANCE,
        now: () => 1_000,
        isProcessLive: () => true,
        wait: () => new Promise<void>(() => undefined),
      }),
    );
    await actionEntered;
    await unlink(lockPath);
    const replacement = record(12, NEW_INSTANCE, 1_300);
    await writeFile(lockPath, replacement, { mode: 0o600 });
    resume();

    await expect(holder).rejects.toBeInstanceOf(FilesystemAssetSecurityError);
    await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(lockPath, 'utf8')).toBe(replacement);
  });

  it('fails closed on a malformed lock record', async () => {
    const storageRoot = await root();
    const anchor = await prepareFilesystemAssetLayout(storageRoot);
    await writeFile(join(filesystemAssetStateDirectory(storageRoot), 'coordination.lock'), '{}\n', {
      mode: 0o600,
    });

    await expect(
      withFilesystemAssetLock(storageRoot, anchor, async () => undefined, runtime()),
    ).rejects.toBeInstanceOf(FilesystemAssetSecurityError);
  });
});

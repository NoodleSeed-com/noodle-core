import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertFilesystemAssetLayout,
  assertRegularFileOrAbsent,
  type FilesystemAssetLayoutAnchor,
  FilesystemAssetSecurityError,
  filesystemAssetStateDirectory,
  isMissing,
  isPositiveSafeInteger,
  isRecord,
  isSymlinkOpenError,
  openRegularFileNoFollow,
  SAFE_FILESYSTEM_ASSET_OBJECT_KEY,
  syncDirectory,
} from './filesystem-layout.js';
import { readBounded } from './filesystem-store-support.js';

const LOCK_FILE = 'coordination.lock';
const RECOVERY_FILE = 'coordination.recovery';
const RESERVATIONS_FILE = 'reservations.json';
const MAX_LOCK_BYTES = 1024;
const MAX_RESERVATION_BYTES = 1024 * 1024;
const MAX_RESERVATION_RECORDS = 10_000;
const LOCK_RETRY_MS = 5;
const DEFAULT_LOCK_LEASE_MS = 30_000;
const DEFAULT_LOCK_HEARTBEAT_MS = 10_000;
const PROCESS_INSTANCE_ID = randomBytes(16).toString('hex');
const PROCESS_LOCAL_LOCK_TAILS = new Map<string, Promise<void>>();

export interface FilesystemAssetReservation {
  readonly id: string;
  readonly objectKey: string;
  readonly identityHash: string;
  readonly byteLength: number;
  readonly expiresAt: number;
}

export interface FilesystemAssetReservationState {
  readonly version: 1;
  readonly capabilities: FilesystemAssetReservation[];
}

interface LockOwner {
  readonly version: 2;
  readonly pid: number;
  readonly processInstanceId: string;
  readonly nonce: string;
  readonly leaseExpiresAt: number;
}

export interface FilesystemAssetLockRuntime {
  readonly pid: number;
  readonly processInstanceId: string;
  readonly now: () => number;
  readonly isProcessLive: (pid: number) => boolean;
  readonly wait: (milliseconds: number) => Promise<void>;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
}

export interface FilesystemAssetLockGuard {
  readonly assertOwned: () => Promise<void>;
}

const DEFAULT_LOCK_RUNTIME: FilesystemAssetLockRuntime = {
  pid: process.pid,
  processInstanceId: PROCESS_INSTANCE_ID,
  now: Date.now,
  isProcessLive: isLiveProcess,
  wait: (milliseconds) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds).unref();
    }),
  leaseMs: DEFAULT_LOCK_LEASE_MS,
  heartbeatMs: DEFAULT_LOCK_HEARTBEAT_MS,
};

/**
 * Serialize state transitions with an exclusive fixed-path file. This is a single-node,
 * multi-process lock; callers keep streamed upload bytes outside the critical section.
 */
export async function withFilesystemAssetLock<T>(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  action: (guard: FilesystemAssetLockGuard) => Promise<T>,
  runtime: FilesystemAssetLockRuntime = DEFAULT_LOCK_RUNTIME,
): Promise<T> {
  const execute = () => withFilesystemAssetFileLock(root, anchor, action, runtime);
  return withProcessLocalLockTurn(`${anchor.root.realPath}\0${runtime.processInstanceId}`, execute);
}

async function withFilesystemAssetFileLock<T>(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  action: (guard: FilesystemAssetLockGuard) => Promise<T>,
  runtime: FilesystemAssetLockRuntime,
): Promise<T> {
  validateLockRuntime(runtime);
  const held = await acquireLock(root, anchor, runtime);
  let heartbeatStopped = false;
  let stopHeartbeat!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stopHeartbeat = () => {
      heartbeatStopped = true;
      resolve();
    };
  });
  let heartbeatFailure: unknown;
  const heartbeat = heartbeatLock(
    root,
    anchor,
    held,
    runtime,
    stopped,
    () => heartbeatStopped,
  ).catch((error) => {
    heartbeatFailure = error;
  });
  const guard: FilesystemAssetLockGuard = {
    assertOwned: async () => {
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
      await assertHeldLockOwnership(root, anchor, held, runtime);
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    },
  };
  try {
    const result = await action(guard);
    await guard.assertOwned();
    return result;
  } finally {
    stopHeartbeat();
    await heartbeat;
    await releaseLock(root, anchor, held);
  }
}

async function withProcessLocalLockTurn<T>(key: string, action: () => Promise<T>): Promise<T> {
  const predecessor = PROCESS_LOCAL_LOCK_TAILS.get(key) ?? Promise.resolve();
  let advance!: () => void;
  const turn = new Promise<void>((resolve) => {
    advance = resolve;
  });
  const tail = predecessor.then(() => turn);
  PROCESS_LOCAL_LOCK_TAILS.set(key, tail);
  await predecessor;
  try {
    return await action();
  } finally {
    advance();
    if (PROCESS_LOCAL_LOCK_TAILS.get(key) === tail) PROCESS_LOCAL_LOCK_TAILS.delete(key);
  }
}

export async function readFilesystemAssetReservations(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
): Promise<FilesystemAssetReservationState> {
  await assertFilesystemAssetLayout(root, anchor);
  const path = join(filesystemAssetStateDirectory(root), RESERVATIONS_FILE);
  let handle: FileHandle;
  try {
    handle = await openRegularFileNoFollow(path, 'asset reservation state path');
  } catch (error) {
    if (isMissing(error)) return { version: 1, capabilities: [] };
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.size <= 0 || stats.size > MAX_RESERVATION_BYTES) {
      throw new FilesystemAssetSecurityError('asset reservation state is invalid');
    }
    const raw = (await readBounded(handle, MAX_RESERVATION_BYTES)).toString('utf8');
    return parseReservationState(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof FilesystemAssetSecurityError) throw error;
    throw new FilesystemAssetSecurityError('asset reservation state is invalid');
  } finally {
    await handle.close();
    await assertFilesystemAssetLayout(root, anchor);
  }
}

export async function writeFilesystemAssetReservations(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  state: FilesystemAssetReservationState,
  guard: FilesystemAssetLockGuard,
): Promise<void> {
  const parsed = parseReservationState(state);
  const serialized = `${JSON.stringify(parsed)}\n`;
  if (Buffer.byteLength(serialized) > MAX_RESERVATION_BYTES) {
    throw new FilesystemAssetSecurityError('asset reservation state exceeds its storage bound');
  }
  await assertFilesystemAssetLayout(root, anchor);
  const directory = filesystemAssetStateDirectory(root);
  const destination = join(directory, RESERVATIONS_FILE);
  await assertRegularFileOrAbsent(destination, 'asset reservation state path');
  const temp = join(directory, `.reservations.tmp-${randomBytes(16).toString('hex')}`);
  let handle: FileHandle | undefined;
  let identity: FileIdentity | undefined;
  try {
    handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    identity = identityFromStats(await handle.stat());
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertFilesystemAssetLayout(root, anchor);
    await assertRegularFileOrAbsent(destination, 'asset reservation state path');
    await guard.assertOwned();
    await rename(temp, destination);
    await syncDirectory(directory);
    await assertFilesystemAssetLayout(root, anchor);
  } finally {
    await handle?.close().catch(() => undefined);
    if (identity !== undefined) await safeUnlinkIdentity(temp, identity);
  }
}

export function sweepFilesystemAssetReservations(
  state: FilesystemAssetReservationState,
  now: number,
): FilesystemAssetReservationState {
  return {
    version: 1,
    capabilities: state.capabilities.filter((capability) => capability.expiresAt > now),
  };
}

function parseReservationState(value: unknown): FilesystemAssetReservationState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.capabilities)) {
    throw new FilesystemAssetSecurityError('asset reservation state is invalid');
  }
  if (value.capabilities.length > MAX_RESERVATION_RECORDS) {
    throw new FilesystemAssetSecurityError('asset reservation state is invalid');
  }
  const ids = new Set<string>();
  const capabilities = value.capabilities.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{32}$/.test(item.id) ||
      ids.has(item.id) ||
      typeof item.objectKey !== 'string' ||
      !SAFE_FILESYSTEM_ASSET_OBJECT_KEY.test(item.objectKey) ||
      typeof item.identityHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.identityHash) ||
      !isPositiveSafeInteger(item.byteLength) ||
      !isPositiveSafeInteger(item.expiresAt)
    ) {
      throw new FilesystemAssetSecurityError('asset reservation state is invalid');
    }
    ids.add(item.id);
    return {
      id: item.id,
      objectKey: item.objectKey,
      identityHash: item.identityHash,
      byteLength: item.byteLength,
      expiresAt: item.expiresAt,
    };
  });
  return { version: 1, capabilities };
}

async function acquireLock(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  runtime: FilesystemAssetLockRuntime,
): Promise<HeldLock> {
  const path = join(filesystemAssetStateDirectory(root), LOCK_FILE);
  const nonce = randomBytes(16).toString('hex');
  for (;;) {
    await assertFilesystemAssetLayout(root, anchor);
    if (await finishRecovery(root, anchor, path, runtime)) {
      continue;
    }
    const pendingPath = join(filesystemAssetStateDirectory(root), `.coordination.pending-${nonce}`);
    let pendingHandle: FileHandle | undefined;
    let pendingIdentity: FileIdentity | undefined;
    let published = false;
    try {
      pendingHandle = await open(
        pendingPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      await pendingHandle.chmod(0o600);
      pendingIdentity = identityFromStats(await pendingHandle.stat());
      const serialized = serializeLockOwner({
        version: 2,
        pid: runtime.pid,
        processInstanceId: runtime.processInstanceId,
        nonce,
        leaseExpiresAt: runtime.now() + runtime.leaseMs,
      });
      await pendingHandle.writeFile(serialized.value);
      await pendingHandle.sync();
      await assertFilesystemAssetLayout(root, anchor);
      await link(pendingPath, path);
      published = true;
      await assertFilesystemAssetLayout(root, anchor);
      await assertPathIdentity(pendingPath, pendingIdentity, 'asset coordination pending path');
      await assertPathIdentity(path, pendingIdentity, 'asset coordination lock path');
      await unlink(pendingPath);
      await syncDirectory(filesystemAssetStateDirectory(root));
      return {
        handle: pendingHandle,
        path,
        pid: runtime.pid,
        nonce,
        processInstanceId: runtime.processInstanceId,
        leaseOffset: serialized.leaseOffset,
        identity: pendingIdentity,
      };
    } catch (error) {
      await pendingHandle?.close().catch(() => undefined);
      if (pendingIdentity !== undefined) await safeUnlinkIdentity(pendingPath, pendingIdentity);
      if (published && pendingIdentity !== undefined)
        await safeUnlinkIdentity(path, pendingIdentity);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (isSymlinkOpenError(error)) {
          throw new FilesystemAssetSecurityError('asset coordination lock must not be a symlink');
        }
        throw error;
      }
    }
    let owner: LockOwner;
    try {
      owner = await readLockOwner(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!lockOwnerIsActive(owner, runtime)) {
      await recoverStaleLock(root, anchor, path, runtime);
      continue;
    }
    await runtime.wait(LOCK_RETRY_MS);
  }
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface HeldLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly pid: number;
  readonly nonce: string;
  readonly processInstanceId: string;
  readonly leaseOffset: number;
  readonly identity: FileIdentity;
}

async function recoverStaleLock(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  lockPath: string,
  runtime: FilesystemAssetLockRuntime,
): Promise<void> {
  const recoveryPath = join(filesystemAssetStateDirectory(root), RECOVERY_FILE);
  try {
    await link(lockPath, recoveryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' || isMissing(error)) return;
    throw error;
  }
  await assertFilesystemAssetLayout(root, anchor);
  await finishRecovery(root, anchor, lockPath, runtime);
}

async function finishRecovery(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  lockPath: string,
  runtime: FilesystemAssetLockRuntime,
): Promise<boolean> {
  const recoveryPath = join(filesystemAssetStateDirectory(root), RECOVERY_FILE);
  if (!(await assertRegularFileOrAbsent(recoveryPath, 'asset coordination recovery path'))) {
    return false;
  }
  await assertFilesystemAssetLayout(root, anchor);
  const recoveryStats = await lstat(recoveryPath);
  const recoveryIdentity = identityFromStats(recoveryStats);
  const owner = await readLockOwner(recoveryPath);
  if (lockOwnerIsActive(owner, runtime)) {
    await safeUnlinkIdentity(recoveryPath, recoveryIdentity);
    return true;
  }
  try {
    const lockStats = await lstat(lockPath);
    if (lockStats.dev === recoveryIdentity.device && lockStats.ino === recoveryIdentity.inode) {
      await unlink(lockPath);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await safeUnlinkIdentity(recoveryPath, recoveryIdentity);
  await syncDirectory(filesystemAssetStateDirectory(root));
  await assertFilesystemAssetLayout(root, anchor);
  return true;
}

async function heartbeatLock(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  held: HeldLock,
  runtime: FilesystemAssetLockRuntime,
  stopped: Promise<void>,
  isStopped: () => boolean,
): Promise<void> {
  for (;;) {
    if (isStopped()) return;
    const outcome = await Promise.race([
      runtime.wait(runtime.heartbeatMs).then(() => 'heartbeat' as const),
      stopped.then(() => 'stopped' as const),
    ]);
    if (outcome === 'stopped' || isStopped()) return;
    await assertHeldLockOwnership(root, anchor, held, runtime);
    const lease = Buffer.from(formatLeaseExpiry(runtime.now() + runtime.leaseMs));
    await writeAllAt(held.handle, lease, held.leaseOffset);
    await held.handle.sync();
    await assertPathIdentity(held.path, held.identity, 'asset coordination lock path');
  }
}

async function assertHeldLockOwnership(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  held: HeldLock,
  runtime: FilesystemAssetLockRuntime,
): Promise<void> {
  await assertFilesystemAssetLayout(root, anchor);
  await assertPathIdentity(held.path, held.identity, 'asset coordination lock path');
  const owner = await readLockOwner(held.path);
  if (
    owner.pid !== held.pid ||
    owner.nonce !== held.nonce ||
    owner.processInstanceId !== held.processInstanceId ||
    owner.leaseExpiresAt <= runtime.now()
  ) {
    throw new FilesystemAssetSecurityError('asset coordination lock ownership changed');
  }
}

async function releaseLock(
  root: string,
  anchor: FilesystemAssetLayoutAnchor,
  held: HeldLock,
): Promise<void> {
  try {
    await assertFilesystemAssetLayout(root, anchor);
    const handleStats = await held.handle.stat();
    const pathStats = await lstat(held.path);
    if (
      pathStats.isSymbolicLink() ||
      !pathStats.isFile() ||
      handleStats.dev !== pathStats.dev ||
      handleStats.ino !== pathStats.ino
    ) {
      throw new FilesystemAssetSecurityError('asset coordination lock identity changed');
    }
    const owner = await readLockOwner(held.path);
    if (
      owner.pid !== held.pid ||
      owner.nonce !== held.nonce ||
      owner.processInstanceId !== held.processInstanceId
    ) {
      throw new FilesystemAssetSecurityError('asset coordination lock ownership changed');
    }
    const released = join(
      filesystemAssetStateDirectory(root),
      `.coordination.released-${held.nonce}`,
    );
    await rename(held.path, released);
    const releasedStats = await lstat(released);
    if (releasedStats.dev !== handleStats.dev || releasedStats.ino !== handleStats.ino) {
      throw new FilesystemAssetSecurityError('asset coordination lock identity changed');
    }
    await unlink(released);
    await syncDirectory(filesystemAssetStateDirectory(root));
    await assertFilesystemAssetLayout(root, anchor);
  } finally {
    await held.handle.close();
  }
}

async function readLockOwner(path: string): Promise<LockOwner> {
  const handle = await openRegularFileNoFollow(path, 'asset coordination lock path');
  try {
    const stats = await handle.stat();
    if (stats.size <= 0 || stats.size > MAX_LOCK_BYTES) {
      throw new FilesystemAssetSecurityError('asset coordination lock is invalid');
    }
    const value = JSON.parse(
      (await readBounded(handle, MAX_LOCK_BYTES)).toString('utf8'),
    ) as unknown;
    if (
      !isRecord(value) ||
      value.version !== 2 ||
      !isPositiveSafeInteger(value.pid) ||
      typeof value.processInstanceId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.processInstanceId) ||
      typeof value.nonce !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.nonce) ||
      typeof value.leaseExpiresAt !== 'string' ||
      !/^\d{16}$/.test(value.leaseExpiresAt)
    ) {
      throw new FilesystemAssetSecurityError('asset coordination lock is invalid');
    }
    const leaseExpiresAt = Number(value.leaseExpiresAt);
    if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= 0) {
      throw new FilesystemAssetSecurityError('asset coordination lock is invalid');
    }
    return {
      version: 2,
      pid: value.pid,
      processInstanceId: value.processInstanceId,
      nonce: value.nonce,
      leaseExpiresAt,
    };
  } catch (error) {
    if (error instanceof FilesystemAssetSecurityError) throw error;
    if (isMissing(error)) throw error;
    throw new FilesystemAssetSecurityError('asset coordination lock is invalid');
  } finally {
    await handle.close();
  }
}

function serializeLockOwner(owner: LockOwner): {
  readonly value: Buffer;
  readonly leaseOffset: number;
} {
  const lease = formatLeaseExpiry(owner.leaseExpiresAt);
  const value = `${JSON.stringify({
    version: owner.version,
    pid: owner.pid,
    processInstanceId: owner.processInstanceId,
    nonce: owner.nonce,
    leaseExpiresAt: lease,
  })}\n`;
  const leaseOffset = Buffer.byteLength(value.slice(0, value.indexOf(lease)));
  return { value: Buffer.from(value), leaseOffset };
}

function formatLeaseExpiry(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new FilesystemAssetSecurityError('asset coordination lock lease is invalid');
  }
  return String(value).padStart(16, '0');
}

function lockOwnerIsActive(owner: LockOwner, runtime: FilesystemAssetLockRuntime): boolean {
  return runtime.isProcessLive(owner.pid) && owner.leaseExpiresAt > runtime.now();
}

function validateLockRuntime(runtime: FilesystemAssetLockRuntime): void {
  if (
    !isPositiveSafeInteger(runtime.pid) ||
    !/^[a-f0-9]{32}$/.test(runtime.processInstanceId) ||
    !isPositiveSafeInteger(runtime.leaseMs) ||
    !isPositiveSafeInteger(runtime.heartbeatMs) ||
    runtime.heartbeatMs >= runtime.leaseMs
  ) {
    throw new TypeError('filesystem asset lock runtime is invalid');
  }
}

function identityFromStats(stats: { readonly dev: number; readonly ino: number }): FileIdentity {
  return { device: stats.dev, inode: stats.ino };
}

async function assertPathIdentity(
  path: string,
  identity: FileIdentity,
  label: string,
): Promise<void> {
  const stats = await lstat(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.dev !== identity.device ||
    stats.ino !== identity.inode
  ) {
    throw new FilesystemAssetSecurityError(`${label} identity changed`);
  }
}

async function safeUnlinkIdentity(path: string, identity: FileIdentity): Promise<void> {
  try {
    await assertPathIdentity(path, identity, 'asset coordination temporary path');
    await unlink(path);
  } catch (error) {
    if (!isMissing(error) && !(error instanceof FilesystemAssetSecurityError)) throw error;
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function writeAllAt(handle: FileHandle, bytes: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, position + offset);
    offset += result.bytesWritten;
  }
}

import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type BuildReadinessSnapshot,
  parseBuildReadinessSnapshot,
  transitionBuildRun,
} from './build-readiness-contract.js';

const HANDLE = /^[A-Za-z0-9_-]{22,128}$/;
const STALE_LOCK_MS = 5 * 60 * 1000;

export class BuildReadinessStoreLockError extends Error {
  readonly workspaceHandle: string;

  constructor(workspaceHandle: string) {
    super(`Build readiness state is locked for workspace ${workspaceHandle}.`);
    this.name = 'BuildReadinessStoreLockError';
    this.workspaceHandle = workspaceHandle;
  }
}

export class BuildReadinessStore {
  readonly root: string;
  readonly #locks = new Map<string, Promise<void>>();

  constructor(root: string) {
    this.root = root;
  }

  pathFor(handle: string): string {
    if (!HANDLE.test(handle)) throw new Error('invalid workspace handle');
    return join(this.root, `${handle}.json`);
  }

  async read(handle: string): Promise<BuildReadinessSnapshot | undefined> {
    await this.#ensureRoot();
    const path = this.pathFor(handle);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    try {
      return parseBuildReadinessSnapshot(JSON.parse(text));
    } catch {
      await rename(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`);
      return undefined;
    }
  }

  async write(snapshot: BuildReadinessSnapshot): Promise<void> {
    const validated = parseBuildReadinessSnapshot(snapshot);
    await this.#ensureRoot();
    const path = this.pathFor(validated.workspaceHandle);
    const temporary = `${path}.tmp-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  }

  async mutate(
    handle: string,
    update: (
      current: BuildReadinessSnapshot | undefined,
    ) => BuildReadinessSnapshot | Promise<BuildReadinessSnapshot>,
  ): Promise<BuildReadinessSnapshot> {
    return this.#withLock(handle, async () => {
      const next = parseBuildReadinessSnapshot(await update(await this.read(handle)));
      if (next.workspaceHandle !== handle)
        throw new Error('workspace handle mutation is forbidden');
      await this.write(next);
      return next;
    });
  }

  async interruptExpiredRuns(
    handle: string,
    now: Date,
    expiryMs = 30_000,
  ): Promise<BuildReadinessSnapshot | undefined> {
    const current = await this.read(handle);
    if (current === undefined) return undefined;
    const timestamp = now.toISOString();
    const cutoff = now.getTime() - Math.max(1, expiryMs);
    if (!current.runs.some((run) => isExpiredActiveRun(run, cutoff))) return current;
    return this.mutate(handle, (current) => {
      if (current === undefined) throw new Error('build readiness state disappeared');
      let changed = false;
      const runs = current.runs.map((run) => {
        if (!isExpiredActiveRun(run, cutoff)) return run;
        changed = true;
        return transitionBuildRun(run, {
          status: 'interrupted',
          heartbeatAt: timestamp,
          finishedAt: timestamp,
        });
      });
      return changed ? { ...current, updatedAt: timestamp, runs } : current;
    });
  }

  async #ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  async #withLock<T>(handle: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(handle) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const queued = previous.then(() => gate);
    this.#locks.set(handle, queued);
    await previous;
    let token: string | undefined;
    try {
      token = await this.#acquireFileLock(handle);
      return await operation();
    } finally {
      if (token !== undefined) await this.#releaseFileLock(handle, token);
      release();
      if (this.#locks.get(handle) === queued) this.#locks.delete(handle);
    }
  }

  async #acquireFileLock(handle: string): Promise<string> {
    await this.#ensureRoot();
    const path = this.#lockPath(handle);
    const token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await writeFile(
          path,
          `${JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          { encoding: 'utf8', flag: 'wx', mode: 0o600 },
        );
        return token;
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        if (!(await isStaleLock(path))) throw new BuildReadinessStoreLockError(handle);
        try {
          await rename(path, `${path}.stale-${randomUUID()}`);
        } catch (renameError) {
          if (!isMissing(renameError)) throw renameError;
        }
      }
    }
    throw new BuildReadinessStoreLockError(handle);
  }

  async #releaseFileLock(handle: string, token: string): Promise<void> {
    const path = this.#lockPath(handle);
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as { token?: unknown };
      if (value.token === token) await unlink(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  #lockPath(handle: string): string {
    this.pathFor(handle);
    return join(this.root, `${handle}.lock`);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isExpiredActiveRun(run: BuildReadinessSnapshot['runs'][number], cutoff: number): boolean {
  return (
    (run.status === 'queued' || run.status === 'running') && Date.parse(run.heartbeatAt) <= cutoff
  );
}

async function isStaleLock(path: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {
      pid?: unknown;
      createdAt?: unknown;
    };
    if (typeof raw.pid !== 'number' || typeof raw.createdAt !== 'string') {
      return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS;
    }
    const createdAt = Date.parse(raw.createdAt);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > STALE_LOCK_MS) return true;
    return !isProcessAlive(raw.pid);
  } catch (error) {
    if (isMissing(error)) return true;
    return Date.now() - (await stat(path)).mtimeMs > STALE_LOCK_MS;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

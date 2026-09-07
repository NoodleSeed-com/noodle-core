import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DESIGN_MAX_BODY_BYTES,
  type DesignSessionV1,
  validateDesignSession,
} from './devtools-design-contract.js';

interface LatestPointerV1 {
  readonly version: 1;
  readonly id: string;
  readonly updatedAt: string;
}

export interface DesignStore {
  readDraft(): DesignSessionV1 | undefined;
  writeDraft(session: DesignSessionV1, expectedUpdatedAt?: string): void;
  finalize(session: DesignSessionV1): DesignSessionV1;
  readLatest(): DesignSessionV1 | undefined;
}

export class DesignStoreConflictError extends Error {
  readonly current: DesignSessionV1;

  constructor(current: DesignSessionV1) {
    super('The design draft changed since it was loaded.');
    this.name = 'DesignStoreConflictError';
    this.current = current;
  }
}

export class DesignStoreCorruptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DesignStoreCorruptError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function fsyncPath(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function serialized(value: unknown): string {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body, 'utf8') > DESIGN_MAX_BODY_BYTES) {
    throw new Error(`Design Session exceeds ${DESIGN_MAX_BODY_BYTES} bytes`);
  }
  return body;
}

function atomicWrite(path: string, value: unknown): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized(value), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fsyncPath(temporaryPath);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
    fsyncPath(directory);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function atomicWriteImmutable(path: string, value: unknown): void {
  const directory = dirname(path);
  ensurePrivateDirectory(directory);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized(value), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fsyncPath(temporaryPath);
    linkSync(temporaryPath, path);
    chmodSync(path, 0o600);
    fsyncPath(directory);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function readJson(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    if (statSync(path).size > DESIGN_MAX_BODY_BYTES) {
      throw new Error(`file exceeds ${DESIGN_MAX_BODY_BYTES} bytes`);
    }
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new DesignStoreCorruptError(`Invalid design state at ${path}`, {
      cause: error,
    });
  }
}

function readSession(path: string): DesignSessionV1 | undefined {
  const value = readJson(path);
  if (value === undefined) return undefined;
  try {
    return validateDesignSession(value);
  } catch (error) {
    throw new DesignStoreCorruptError(`Invalid Design Session at ${path}`, {
      cause: error,
    });
  }
}

function readLatestPointer(path: string): LatestPointerV1 | undefined {
  const value = readJson(path);
  if (value === undefined) return undefined;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('latest pointer must be an object');
    }
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input);
    if (
      keys.length !== 3 ||
      !keys.includes('version') ||
      !keys.includes('id') ||
      !keys.includes('updatedAt')
    ) {
      throw new Error('latest pointer has unknown or missing fields');
    }
    if (input.version !== 1) throw new Error('unsupported latest pointer version');
    if (typeof input.id !== 'string' || !UUID.test(input.id)) {
      throw new Error('latest pointer id must be a UUID');
    }
    if (typeof input.updatedAt !== 'string') {
      throw new Error('latest pointer updatedAt must be a string');
    }
    const updatedAt = new Date(input.updatedAt);
    if (Number.isNaN(updatedAt.valueOf()) || updatedAt.toISOString() !== input.updatedAt) {
      throw new Error('latest pointer updatedAt must be an ISO timestamp');
    }
    return { version: 1, id: input.id, updatedAt: input.updatedAt };
  } catch (error) {
    throw new DesignStoreCorruptError(`Invalid latest design pointer at ${path}`, {
      cause: error,
    });
  }
}

export function createDesignStore(projectRoot: string): DesignStore {
  const designDirectory = join(projectRoot, '.noodle', 'design');
  const sessionsDirectory = join(designDirectory, 'sessions');
  const draftPath = join(designDirectory, 'draft.json');
  const latestPath = join(designDirectory, 'latest.json');

  return {
    readDraft(): DesignSessionV1 | undefined {
      return readSession(draftPath);
    },

    writeDraft(session: DesignSessionV1, expectedUpdatedAt?: string): void {
      const validated = validateDesignSession(session);
      if (validated.status !== 'draft') {
        throw new Error('Only draft Design Sessions can be written as the current draft.');
      }
      const current = readSession(draftPath);
      if (current !== undefined) {
        if (expectedUpdatedAt === undefined || current.updatedAt !== expectedUpdatedAt) {
          throw new DesignStoreConflictError(current);
        }
      }
      atomicWrite(draftPath, validated);
    },

    finalize(session: DesignSessionV1): DesignSessionV1 {
      const validated = validateDesignSession(session);
      if (validated.status !== 'draft') {
        throw new Error('Only a draft Design Session can be finalized.');
      }
      const meaningful = validated.annotations.some(
        (annotation) => annotation.intent.trim().length > 0 || annotation.changes.length > 0,
      );
      if (!meaningful) {
        throw new Error('A Design Session needs at least one meaningful annotation.');
      }

      const updatedAt = new Date().toISOString();
      const ready = validateDesignSession({
        ...validated,
        id: randomUUID(),
        status: 'ready',
        updatedAt,
      });
      ensurePrivateDirectory(sessionsDirectory);
      atomicWriteImmutable(join(sessionsDirectory, `${ready.id}.json`), ready);
      atomicWrite(latestPath, {
        version: 1,
        id: ready.id,
        updatedAt: ready.updatedAt,
      } satisfies LatestPointerV1);
      return ready;
    },

    readLatest(): DesignSessionV1 | undefined {
      const pointer = readLatestPointer(latestPath);
      if (pointer === undefined) return undefined;
      const sessionPath = join(sessionsDirectory, `${pointer.id}.json`);
      const session = readSession(sessionPath);
      if (session === undefined) {
        throw new DesignStoreCorruptError(`Latest design snapshot ${pointer.id} does not exist.`);
      }
      if (
        session.id !== pointer.id ||
        session.updatedAt !== pointer.updatedAt ||
        session.status !== 'ready'
      ) {
        throw new DesignStoreCorruptError(
          `Latest design snapshot ${pointer.id} does not match its pointer.`,
        );
      }
      return session;
    },
  };
}

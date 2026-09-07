import { createHash } from 'node:crypto';
import { constants, link, lstat, mkdtemp, open, rmdir, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import {
  AppPurgeReconciliationPreviewArtifactSchema,
  type AppPurgeReconciliationPreviewArtifactV1,
  appPurgeReconciliationChecksumPayload,
} from '@noodle-borg/wire-contracts';

const MAX_PREVIEW_BYTES = 256 * 1024;

/** Create a new approved-preview artifact without overwriting or following caller-controlled links. */
export async function writeAppPurgeReconciliationPreview(
  path: string,
  value: unknown,
): Promise<void> {
  const artifact = validateAppPurgeReconciliationPreview(value);
  if (!isAbsolute(path)) throw previewWriteFailure();
  const bytes = Buffer.from(`${JSON.stringify(artifact)}\n`, 'utf8');
  if (bytes.byteLength > MAX_PREVIEW_BYTES) throw previewWriteFailure();
  let stagingDirectory: string | undefined;
  let stagingPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    stagingDirectory = await mkdtemp(join(dirname(path), '.noodle-app-purge-preview-'));
    const stagingDirectoryStat = await lstat(stagingDirectory);
    if (!stagingDirectoryStat.isDirectory() || (stagingDirectoryStat.mode & 0o077) !== 0) {
      throw previewWriteFailure();
    }
    stagingPath = join(stagingDirectory, 'artifact.json');
    handle = await open(
      stagingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || !isExactMode(Number(stat.mode))) throw previewWriteFailure();
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(stagingPath, path);
  } catch {
    await handle?.close().catch(() => undefined);
    throw previewWriteFailure();
  } finally {
    await cleanPrivateStagingPath(stagingPath, stagingDirectory);
  }
}

/** Read one bounded approved artifact from its opened descriptor and reproduce its checksum. */
export async function readAppPurgeReconciliationPreview(
  path: string,
): Promise<AppPurgeReconciliationPreviewArtifactV1> {
  if (!isAbsolute(path)) throw previewReadFailure();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw previewReadFailure();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !isExactMode(stat.mode) || stat.size > MAX_PREVIEW_BYTES) {
      throw previewReadFailure();
    }
    const buffer = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const read = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    if (bytesRead > MAX_PREVIEW_BYTES) throw previewReadFailure();
    return validateAppPurgeReconciliationPreview(
      JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')),
    );
  } catch {
    throw previewReadFailure();
  } finally {
    await handle.close();
  }
}

/** Strict schema plus canonical SHA-256 verification shared by service and file boundaries. */
export function validateAppPurgeReconciliationPreview(
  value: unknown,
): AppPurgeReconciliationPreviewArtifactV1 {
  const artifact = AppPurgeReconciliationPreviewArtifactSchema.parse(value);
  const { checksum, ...unsigned } = artifact;
  const actual = `sha256:${createHash('sha256')
    .update(appPurgeReconciliationChecksumPayload(unsigned))
    .digest('hex')}`;
  if (checksum !== actual) throw previewReadFailure();
  return artifact;
}

function isExactMode(mode: number): boolean {
  return (mode & 0o7777) === 0o600;
}

async function cleanPrivateStagingPath(
  stagingPath: string | undefined,
  stagingDirectory: string | undefined,
): Promise<void> {
  if (stagingPath !== undefined) await unlink(stagingPath).catch(() => undefined);
  if (stagingDirectory !== undefined) await rmdir(stagingDirectory).catch(() => undefined);
}

class AppPurgePreviewFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppPurgePreviewFileError';
  }
}

function previewWriteFailure(): AppPurgePreviewFileError {
  return new AppPurgePreviewFileError('The preview artifact could not be written safely.');
}

function previewReadFailure(): AppPurgePreviewFileError {
  return new AppPurgePreviewFileError('The approved preview artifact is invalid.');
}

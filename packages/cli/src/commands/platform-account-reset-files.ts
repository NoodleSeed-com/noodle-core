import { constants, open } from 'node:fs/promises';
import {
  type PlatformAccountResetTargetSet,
  PlatformAccountResetTargetSetSchema,
} from '@noodle-borg/wire-contracts';

const MAX_TARGET_FILE_BYTES = 16 * 1024;

/** Read the exact-three target set without following a caller-controlled filesystem link. */
export async function readPlatformAccountResetTargetFile(
  path: string,
): Promise<PlatformAccountResetTargetSet> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw targetFileFailure();
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      !isExactPlatformAccountResetTargetMode(stat.mode) ||
      stat.size > MAX_TARGET_FILE_BYTES
    ) {
      throw targetFileFailure();
    }
    const contents = await handle.readFile('utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_TARGET_FILE_BYTES) throw targetFileFailure();
    return PlatformAccountResetTargetSetSchema.parse(JSON.parse(contents));
  } catch {
    throw targetFileFailure();
  } finally {
    await handle.close();
  }
}

/** Keep permission validation exact, including special mode bits returned by the opened descriptor. */
export function isExactPlatformAccountResetTargetMode(mode: number): boolean {
  return (mode & 0o7777) === 0o600;
}

class PlatformAccountResetTargetFileError extends Error {
  constructor() {
    super('The target file is invalid.');
    this.name = 'PlatformAccountResetTargetFileError';
  }
}

function targetFileFailure(): PlatformAccountResetTargetFileError {
  return new PlatformAccountResetTargetFileError();
}

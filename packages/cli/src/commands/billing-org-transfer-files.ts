import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type BillingOrganizationTransferArtifact,
  BillingOrganizationTransferArtifactSchema,
  type BillingOrganizationTransferAuthorityPath,
} from '@noodle-borg/wire-contracts';

const MAX_ARTIFACT_BYTES = 64 * 1024;

/** Refuse caller-controlled links and special files before a preview request is made. */
export async function assertBillingTransferArtifactDestination(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw artifactFileError();
  }
  throw artifactFileError();
}

/** Install an already-synced private artifact without replacing a raced directory entry. */
export async function installBillingTransferArtifactNoReplace(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  const directory = dirname(destinationPath);
  if (dirname(temporaryPath) !== directory) {
    await unlink(temporaryPath).catch(() => undefined);
    throw artifactFileError();
  }
  try {
    await link(temporaryPath, destinationPath);
    await unlink(temporaryPath);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw artifactFileError();
  }
}

/** Write private reviewed evidence through a same-directory, exclusive temporary file. */
export async function writeBillingTransferArtifact(
  path: string,
  artifact: BillingOrganizationTransferArtifact,
): Promise<void> {
  const validated = BillingOrganizationTransferArtifactSchema.parse(artifact);
  const contents = `${JSON.stringify(validated, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) throw artifactFileError();
  await assertBillingTransferArtifactDestination(path);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await installBillingTransferArtifactNoReplace(temporaryPath, path);
  } catch {
    throw artifactFileError();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

/** Read strict private evidence from an opened descriptor without following a symlink. */
export async function readBillingTransferArtifact<
  TAuthority extends BillingOrganizationTransferAuthorityPath,
>(
  path: string,
  authorityPath: TAuthority,
): Promise<
  Extract<
    BillingOrganizationTransferArtifact,
    {
      readonly authorityPath: TAuthority;
    }
  >
> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw artifactFileError();
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_ARTIFACT_BYTES) {
      throw artifactFileError();
    }
    const contents = await handle.readFile('utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_BYTES) throw artifactFileError();
    const parsed = BillingOrganizationTransferArtifactSchema.parse(JSON.parse(contents));
    if (parsed.authorityPath !== authorityPath) throw artifactFileError();
    return parsed as Extract<
      BillingOrganizationTransferArtifact,
      { readonly authorityPath: TAuthority }
    >;
  } catch {
    throw artifactFileError();
  } finally {
    await handle.close();
  }
}

class BillingTransferArtifactFileError extends Error {
  constructor() {
    super('The billing transfer preview artifact is invalid.');
    this.name = 'BillingTransferArtifactFileError';
  }
}

function artifactFileError(): BillingTransferArtifactFileError {
  return new BillingTransferArtifactFileError();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

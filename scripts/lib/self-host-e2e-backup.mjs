import { chmod, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { assertSameAsset, fetchAsset } from './self-host-e2e-contract.mjs';
import { exerciseHello } from './self-host-e2e-mcp.mjs';

/** Create and verify the journey's private, secret-free database and asset backup. */
export async function backupSelfHostState(input) {
  const relativeBackupRoot = join('.self-host', 'e2e', 'backup');
  const backupRoot = join(input.root, relativeBackupRoot);
  const databaseDump = join(backupRoot, 'database.dump');
  const assetArchive = join(backupRoot, 'assets.tar.gz');
  const combinedArchive = join(input.root, '.self-host', 'e2e', 'noodle-backup.tar.gz');
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await chmod(backupRoot, 0o700);
  await input.compose('backup', ['stop', 'noodle'], 60_000);
  await input.compose(
    'backup',
    ['exec', '-T', 'postgres', 'pg_dump', '-U', 'noodle', '-d', 'noodle', '--format=custom'],
    undefined,
    { stdoutFile: join(relativeBackupRoot, 'database.dump') },
  );
  await input.compose('backup', ['exec', '-T', 'postgres', 'pg_restore', '--list'], undefined, {
    stdinFile: join(relativeBackupRoot, 'database.dump'),
  });
  await input.compose(
    'backup',
    [
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'tar',
      'noodle',
      '-C',
      '/var/lib/noodle/assets',
      '-czf',
      '-',
      '.',
    ],
    120_000,
    { stdoutFile: join(relativeBackupRoot, 'assets.tar.gz') },
  );
  await chmod(databaseDump, 0o600);
  await chmod(assetArchive, 0o600);
  await input.run(
    'backup',
    'tar',
    [
      '-czf',
      join('.self-host', 'e2e', 'noodle-backup.tar.gz'),
      '-C',
      relativeBackupRoot,
      'database.dump',
      'assets.tar.gz',
    ],
    60_000,
  );
  await chmod(combinedArchive, 0o600);
  const assetListing = await input.run(
    'backup',
    'tar',
    ['-tzf', join(relativeBackupRoot, 'assets.tar.gz')],
    30_000,
  );
  const assetEntries = assetListing.stdout
    .trim()
    .split(/\r?\n/)
    .filter((entry) => entry.length > 0 && entry !== './');
  if (
    assetEntries.length === 0 ||
    assetEntries.some((entry) => entry.startsWith('/') || entry.split('/').includes('..'))
  ) {
    throw new Error('asset backup archive contained no safe asset data');
  }
  const listing = await input.run(
    'backup',
    'tar',
    ['-tzf', join('.self-host', 'e2e', 'noodle-backup.tar.gz')],
    30_000,
  );
  const entries = listing.stdout.trim().split(/\r?\n/).sort();
  if (
    entries.length !== 2 ||
    entries[0] !== 'assets.tar.gz' ||
    entries[1] !== 'database.dump' ||
    entries.some((entry) => /(^|\/)\.env(?:$|\/)/.test(entry))
  ) {
    throw new Error('backup archive did not contain only database and asset artifacts');
  }
  const artifacts = await Promise.all(
    [databaseDump, assetArchive, combinedArchive].map((path) => stat(path)),
  );
  const backupDirectory = await stat(backupRoot);
  if (
    !backupDirectory.isDirectory() ||
    (backupDirectory.mode & 0o777) !== 0o700 ||
    artifacts.some(
      (artifact) => !artifact.isFile() || artifact.size === 0 || (artifact.mode & 0o777) !== 0o600,
    )
  ) {
    throw new Error('backup artifact was missing, empty, or not private');
  }
  await input.compose('backup', ['up', '--wait', 'noodle'], 120_000);
  await exerciseHello(
    input.fetch,
    input.helloDefaultUrl,
    '2026-07-28',
    'Hello again, Core!',
    90,
    input.signal,
  );
  assertSameAsset(input.assetBefore, await fetchAsset(input.fetch, input.assetUrl, input.signal));
  return { detail: 'created a secret-free database and asset backup archive' };
}

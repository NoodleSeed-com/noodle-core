import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { DEPLOYMENT_ID_PATTERN } from './validate.js';

const lifecycleTails = new Map<string, Promise<void>>();
/** All adapters for one local directory join the same process-local lifecycle ordering. */
export function serializeFileLifecycle<T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = resolve(directory);
  const result = (lifecycleTails.get(key) ?? Promise.resolve()).then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  lifecycleTails.set(key, tail);
  void tail.then(() => {
    if (lifecycleTails.get(key) === tail) lifecycleTails.delete(key);
  });
  return result;
}

/** Fail closed on an unreadable deletion journal; missing means no deletions have committed. */
export async function readDeletedDeploymentIds(directory: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(join(directory, 'deleted-deployments.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
  const ids: unknown = JSON.parse(text);
  if (
    !Array.isArray(ids) ||
    ids.some((id) => typeof id !== 'string' || !DEPLOYMENT_ID_PATTERN.test(id))
  ) {
    throw new Error('Invalid deployment deletion journal');
  }
  return new Set<string>(ids);
}

/** Rename is the logical commit; retained ID tombstones also reject retries that would resurrect records. */
export async function commitDeletedDeploymentIds(
  directory: string,
  ids: readonly string[],
): Promise<void> {
  const deleted = new Set(await readDeletedDeploymentIds(directory));
  for (const id of ids) deleted.add(id);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'deleted-deployments.json');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify([...deleted].sort()));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  // Persist both the commit rename and the metadata directory before removing any deployment files.
  for (const parent of [directory, dirname(directory)]) {
    const handle = await open(parent, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

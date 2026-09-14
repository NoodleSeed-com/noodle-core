import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { commitDeletedDeploymentIds } from '../src/store/json-file-deletion.js';
import { InMemoryArtifactStore, JsonFileArtifactStore } from '../src/store.js';
import { ACTIVE, deletionSuite, HISTORY, TENANT } from './deployment-deletion-suite.js';

const dirs: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'noodle-delete-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
describe('memory deployment deletion', () =>
  deletionSuite(async () => new InMemoryArtifactStore()));
describe('file deployment deletion', () =>
  deletionSuite(async () => new JsonFileArtifactStore(await directory())));
it('persists deletion across a file-store restart and refuses same-ID resurrection', async () => {
  const dir = await directory();
  const first = new JsonFileArtifactStore(dir);
  await first.append(HISTORY);
  await first.append(ACTIVE);
  await first.deleteDeployments(TENANT, {
    kind: 'version',
    serverVersion: '1',
    expectedDeploymentIds: [HISTORY.deploymentId, ACTIVE.deploymentId],
  });
  const second = new JsonFileArtifactStore(dir);
  expect(await second.loadAll()).toEqual([]);
  expect(await second.get(ACTIVE.deploymentId)).toBeUndefined();
  await expect(second.append(ACTIVE)).rejects.toThrow('deleted');
});
it('hides physically remaining records after the file deletion commit and after restart', async () => {
  const dir = await directory();
  const store = new JsonFileArtifactStore(dir);
  await store.append(HISTORY);
  await store.append(ACTIVE);
  // A committed journal with deployment files still present is the exact interrupted-cleanup state.
  await commitDeletedDeploymentIds(join(dir, 'deployment-metadata'), [
    HISTORY.deploymentId,
    ACTIVE.deploymentId,
  ]);
  const restarted = new JsonFileArtifactStore(dir);
  expect(await restarted.get(HISTORY.deploymentId)).toBeUndefined();
  expect(await restarted.loadAll()).toEqual([]);
  await expect(restarted.append(HISTORY)).rejects.toThrow('deleted');
});
it('serializes two file-store instances through one inventory decision', async () => {
  const dir = await directory();
  const first = new JsonFileArtifactStore(dir);
  const second = new JsonFileArtifactStore(dir);
  for (const record of [HISTORY, ACTIVE]) await first.append(record);
  const [removed] = await Promise.all([
    first.deleteDeployments(TENANT, {
      kind: 'version',
      serverVersion: '1',
      expectedDeploymentIds: [HISTORY.deploymentId, ACTIVE.deploymentId],
    }),
    second.append({ ...ACTIVE, deploymentId: 'next', deploymentVersion: 3 }),
  ]);
  expect(removed.ok).toBe(true);
  expect((await second.loadAll()).map((record) => record.deploymentId)).toEqual(['next']);
});
it('fails closed when a file deletion journal cannot be read safely', async () => {
  const dir = await directory();
  const store = new JsonFileArtifactStore(dir);
  await store.append(ACTIVE);
  await commitDeletedDeploymentIds(join(dir, 'deployment-metadata'), []);
  await writeFile(join(dir, 'deployment-metadata', 'deleted-deployments.json'), '{}');
  await expect(store.get(ACTIVE.deploymentId)).rejects.toThrow(
    'Invalid deployment deletion journal',
  );
  await expect(store.loadAll()).rejects.toThrow('Invalid deployment deletion journal');
});

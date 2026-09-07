import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileManifest, sha256Canonical } from '@noodle-borg/compiler';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createAppPackageSnapshot, parseAppPackageSnapshot } from '../src/app-package-snapshot.js';
import {
  type DeployRecord,
  InMemoryArtifactStore,
  JsonFileArtifactStore,
  ServerRegistry,
} from '../src/index.js';

const GUIDED = `
manifestVersion: '2'
server:
  name: package_store
  title: Package Store
  version: 1.0.0
  agentGuide:
    description: Use Package Store to list records.
    useWhen: [A user asks for stored records.]
    workflows:
      - id: list_records
        title: List records
        steps: [{ capability: { kind: tool, name: list_records } }]
    boundaries: [Do not invent records.]
    examples: [{ prompt: List records., workflow: list_records }]
tools:
  - name: list_records
    description: List records.
    inputSchema: { type: object, properties: {}, additionalProperties: false }
    fulfilment: { steps: [], output: { records: [] } }
`;

const compiled = compileManifest(parse(GUIDED));
if (!compiled.ok || compiled.appPackage === undefined) {
  throw new Error('test App Package fixture must compile');
}
const SNAPSHOT = createAppPackageSnapshot(compiled.appPackage);

function snapshotWithFiles(files: typeof SNAPSHOT.files) {
  return {
    ...SNAPSHOT,
    files,
    snapshotSha256: sha256Canonical({
      artifact: SNAPSHOT.artifact,
      rendererVersion: SNAPSHOT.rendererVersion,
      files: files.map(({ target, path, sha256, byteLength }) => ({
        target,
        path,
        sha256,
        byteLength,
      })),
    }),
  };
}

function snapshotWithSerializedBytes(byteLength: number) {
  const initialFiles = SNAPSHOT.files.map((file) => ({ ...file }));
  const candidate = (files: typeof initialFiles) => ({
    schemaVersion: 1 as const,
    artifact: SNAPSHOT.artifact,
    rendererVersion: SNAPSHOT.rendererVersion,
    files,
    snapshotSha256: sha256Canonical({
      artifact: SNAPSHOT.artifact,
      rendererVersion: SNAPSHOT.rendererVersion,
      files: files.map(({ target, path, sha256, byteLength: bytes }) => ({
        target,
        path,
        sha256,
        byteLength: bytes,
      })),
    }),
  });
  const baseline = candidate(initialFiles);
  const baselineBytes = Buffer.byteLength(JSON.stringify(baseline), 'utf8');
  const extra = byteLength - baselineBytes;
  if (extra < 0) throw new Error('target snapshot size is too small for the fixture');
  const files = initialFiles.map((file, index) =>
    index === 0 ? { ...file, path: `${file.path}${'p'.repeat(extra)}` } : file,
  );
  const sized = candidate(files);
  expect(Buffer.byteLength(JSON.stringify(sized), 'utf8')).toBe(byteLength);
  return sized;
}
const RECORD: DeployRecord = {
  schemaVersion: 1,
  deploymentId: 'package-store-00000001',
  orgSlug: 'acme',
  appSlug: 'package-store',
  environment: 'prod',
  serverVersion: '1',
  deploymentVersion: 1,
  active: true,
  serverName: 'package_store',
  createdAt: '2026-08-08T00:00:00.000Z',
  accessMode: 'owner-only',
  manifest: GUIDED,
  secrets: { enc: 'none', values: {} },
  appPackageSnapshot: SNAPSHOT,
};

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

async function storeFixture(kind: 'memory' | 'json') {
  if (kind === 'memory') return { store: new InMemoryArtifactStore() };
  const dir = await mkdtemp(join(tmpdir(), 'noodle-app-package-store-'));
  dirs.push(dir);
  return { store: new JsonFileArtifactStore(dir), dir };
}

describe.each(['memory', 'json'] as const)('%s App Package persistence', (kind) => {
  it('preserves exact snapshot bytes, hashes, and lifecycle transitions', async () => {
    const { store } = await storeFixture(kind);
    await store.append(RECORD);

    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
    expect((await store.loadAll())[0]?.appPackageSnapshot).toEqual(SNAPSHOT);

    const newer = {
      ...RECORD,
      deploymentId: 'package-store-00000002',
      deploymentVersion: 2,
    };
    await store.append(newer);
    await store.activateDeployment(
      { org: RECORD.orgSlug, app: RECORD.appSlug, env: RECORD.environment },
      RECORD.deploymentId,
    );
    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
    expect((await store.get(newer.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);

    await store.archiveApp(RECORD.orgSlug, RECORD.appSlug, '2026-08-09T00:00:00.000Z');
    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
    await store.restoreApp(RECORD.orgSlug, RECORD.appSlug);
    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
  });

  it('accepts legacy absence and omits a malformed snapshot without blocking recovery', async () => {
    const fixture = await storeFixture(kind);
    const legacy = { ...RECORD, appPackageSnapshot: undefined };
    const malformed = {
      ...RECORD,
      deploymentId: 'package-store-00000003',
      appPackageSnapshot: { schemaVersion: 1, artifact: { secret: 'do-not-surface' } },
    } as unknown as DeployRecord;
    await fixture.store.append(legacy);
    if (kind === 'json' && fixture.dir !== undefined) {
      await writeFile(
        join(fixture.dir, 'deployments', `${malformed.deploymentId}.json`),
        `${JSON.stringify(malformed)}\n`,
        'utf8',
      );
    } else {
      await fixture.store.append(malformed);
    }

    expect((await fixture.store.get(legacy.deploymentId))?.appPackageSnapshot).toBeUndefined();
    const safeMalformed = await fixture.store.get(malformed.deploymentId);
    expect(safeMalformed?.appPackageSnapshot).toBeUndefined();
    expect(JSON.stringify(safeMalformed)).not.toContain('do-not-surface');

    const registry = new ServerRegistry(fixture.store);
    const recovered = await registry.recover();
    expect(recovered).toEqual({ recovered: 2, failed: [] });
    expect(
      await registry.getDeploymentPackage(RECORD.orgSlug, malformed.deploymentId),
    ).toBeUndefined();
  });

  it('allows exact replay but rejects a different snapshot before overwrite', async () => {
    const { store } = await storeFixture(kind);
    await store.append(RECORD);
    await store.append({ ...RECORD });
    const conflict = {
      ...RECORD,
      appPackageSnapshot: { ...SNAPSHOT, snapshotSha256: 'f'.repeat(64) },
    };

    await expect(store.append(conflict)).rejects.toThrow(
      `app package snapshot conflict for deployment ${RECORD.deploymentId}`,
    );
    expect((await store.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
  });
});

describe('JSON App Package restart persistence', () => {
  it('returns the exact snapshot from a fresh store instance', async () => {
    const fixture = await storeFixture('json');
    await fixture.store.append(RECORD);

    const restarted = new JsonFileArtifactStore(fixture.dir as string);
    expect((await restarted.get(RECORD.deploymentId))?.appPackageSnapshot).toEqual(SNAPSHOT);
    expect((await restarted.loadAll())[0]?.appPackageSnapshot).toEqual(SNAPSHOT);
  });
});

describe('App Package snapshot serialized bound', () => {
  it('rejects one byte above 1 MiB during parsing', () => {
    expect(parseAppPackageSnapshot(snapshotWithSerializedBytes(1024 * 1024 + 1))).toBeUndefined();
  });
});

describe('App Package persisted-file validation', () => {
  it.each([
    {
      name: 'a non-canonical file path',
      snapshot: () =>
        snapshotWithFiles(
          SNAPSHOT.files.map((file, index) => (index === 0 ? { ...file, path: 'SKILL.md' } : file)),
        ),
    },
    {
      name: 'all files targeting Codex',
      snapshot: () =>
        snapshotWithFiles(SNAPSHOT.files.map((file) => ({ ...file, target: 'codex' as const }))),
    },
    {
      name: 'a SKILL.md above 500 lines',
      snapshot: () => {
        const content = 'line\n'.repeat(501);
        return snapshotWithFiles(
          SNAPSHOT.files.map((file, index) =>
            index === 0
              ? {
                  ...file,
                  content,
                  sha256: createHash('sha256').update(content).digest('hex'),
                  byteLength: Buffer.byteLength(content),
                }
              : file,
          ),
        );
      },
    },
  ])('rejects $name even when the snapshot hash is internally consistent', ({ snapshot }) => {
    expect(parseAppPackageSnapshot(snapshot())).toBeUndefined();
  });
});

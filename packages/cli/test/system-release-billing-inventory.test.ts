import { describe, expect, it } from 'vitest';
import { prepareBillingCatalogRelease } from '../../../scripts/lib/system-release-billing-catalog.mjs';
import { createImageMetadataResolver } from '../../../scripts/lib/system-release-image-metadata.mjs';

const digest = (value: number) => `sha256:${value.toString(16).padStart(64, '0')}`;
const registry = 'us-docker.pkg.dev/p/r';
const image = (value: number) => `${registry}/service@${digest(value)}`;
const sha = 'a'.repeat(40);
const manifest = {
  releaseId: 'r2',
  previousReleaseId: 'r1',
  gitSha: sha,
  manifestChecksum: digest(50),
  images: { service: digest(10), githubBuilder: digest(20) },
};
const previous = {
  components: {
    service: {
      releaseId: 'r1',
      gitSha: 'c'.repeat(40),
      manifestChecksum: digest(51),
      imageDigest: digest(12),
      image: image(12),
    },
  },
};
const config = {
  project: 'p',
  region: 'us',
  artifactsProject: 'p',
  repository: 'r',
  service: 'service',
  builder: 'builder',
};
const imageType = 'application/vnd.oci.image.manifest.v1+json';
function fixture(
  options: {
    legacy?: number;
    unique?: number;
    runningJob?: boolean;
    unknownJob?: boolean;
    databaseJob?: boolean;
    changedTraffic?: boolean;
    tagged?: boolean;
    failImage?: boolean;
    failDelete?: boolean;
    remains?: boolean;
    elapsedPerDelete?: number;
  } = {},
) {
  const revision = (name: string, value: number, source?: string) => ({
    metadata: { name },
    spec: {
      containers: [
        { image: image(value), env: source ? [{ name: 'NOODLE_BUILD_SHA', value: source }] : [] },
      ],
    },
  });
  const revisions = [
    revision('current', 11, sha),
    revision('rollback', 13, previous.components.service.gitSha),
    ...Array.from({ length: options.legacy ?? 2 }, (_, index) =>
      revision(
        `old-${index}`,
        100 + (index % (options.unique ?? 2)),
        index < 206 ? undefined : 'e'.repeat(40),
      ),
    ),
  ];
  const deleted = new Set<string>();
  const metadataReads = new Map<string, number>();
  const commands: string[][] = [];
  let clock = 1_800_000_000_000;
  let descriptions = 0;
  let activeDeletes = 0;
  let peakDeletes = 0;
  let activeMetadata = 0;
  let peakMetadata = 0;
  const executeAsync = async (
    command: string,
    args: string[],
    limits: { timeoutMs: number; maxOutputBytes: number },
  ) => {
    commands.push([command, ...args]);
    expect(limits.timeoutMs).toBeGreaterThan(0);
    expect(limits.timeoutMs).toBeLessThanOrEqual(30_000);
    if (command === 'docker') {
      activeMetadata++;
      peakMetadata = Math.max(peakMetadata, activeMetadata);
      try {
        await Promise.resolve();
        const reference = args.at(-1) as string;
        const value = Number.parseInt(reference.split('@sha256:')[1] ?? '', 16);
        if (options.failImage && value === 100) throw new Error('private-token');
        if (args.includes('--raw')) {
          metadataReads.set(reference, (metadataReads.get(reference) ?? 0) + 1);
          if (value === 10 || value === 12 || value === 14)
            return JSON.stringify({
              schemaVersion: 2,
              mediaType: 'application/vnd.oci.image.index.v1+json',
              manifests: [
                {
                  digest: digest(value + 1),
                  mediaType: imageType,
                  platform: { os: 'linux', architecture: 'amd64' },
                },
              ],
            });
          return JSON.stringify({
            schemaVersion: 2,
            mediaType: imageType,
            config: { digest: digest(90) },
            layers: [],
          });
        }
        return JSON.stringify({
          os: 'linux',
          architecture: 'amd64',
          config: { Labels: value < 100 ? { 'io.noodleseed.billing-catalog-reader': '2' } : null },
        });
      } finally {
        activeMetadata--;
      }
    }
    const kind = args.slice(0, 3).join(' ');
    if (kind === 'run revisions list') {
      expect(limits.maxOutputBytes).toBe(32 * 1024 * 1024);
      return JSON.stringify(
        revisions.filter((revision) => options.remains || !deleted.has(revision.metadata.name)),
      );
    }
    if (kind === 'run services describe') {
      descriptions++;
      return JSON.stringify({
        status: {
          traffic: [
            { revisionName: 'current', percent: 100 },
            ...(options.tagged || (options.changedTraffic && descriptions > 1)
              ? [{ revisionName: 'old-0', percent: 0, tag: 'legacy' }]
              : []),
          ],
        },
      });
    }
    if (kind === 'run jobs list')
      return JSON.stringify([{ metadata: { name: options.unknownJob ? 'other-job' : 'builder' } }]);
    if (kind === 'run jobs describe')
      return JSON.stringify({
        spec: {
          template: {
            spec: {
              template: {
                spec: {
                  containers: [
                    {
                      image: `${registry}/github-builder@${digest(20)}`,
                      env: options.databaseJob ? [{ name: 'DB_NAME', value: 'private' }] : [],
                    },
                  ],
                },
              },
            },
          },
        },
      });
    if (kind === 'run jobs executions')
      return JSON.stringify(
        options.runningJob
          ? [{ status: { runningCount: 1 } }]
          : [{ status: { completionTime: '2026-09-08T00:00:00Z', runningCount: 0 } }],
      );
    if (kind === 'run revisions delete') {
      activeDeletes++;
      peakDeletes = Math.max(peakDeletes, activeDeletes);
      try {
        if (options.failDelete && args[3] === 'old-0') throw new Error('private-token');
        await new Promise((resolve) => setTimeout(resolve, 1));
        deleted.add(args[3] as string);
        clock += options.elapsedPerDelete ?? 0;
        return '';
      } finally {
        activeDeletes--;
      }
    }
    throw new Error('unexpected inventory command');
  };
  const audit: Array<{ phase: string }> = [];
  const input = {
    manifest,
    previous,
    config,
    executeAsync,
    resolveImageMetadata: createImageMetadataResolver(executeAsync),
    nowMs: () => clock,
    onInventory: (value: { phase: string }) => {
      audit.push(value);
    },
  };
  return {
    input,
    revisions,
    commands,
    deleted,
    metadataReads,
    audit,
    stats: () => ({ activeDeletes, peakDeletes, activeMetadata, peakMetadata }),
  };
}

describe('bounded billing release inventory preparation', () => {
  it.each([
    { legacy: 947, unique: 418 },
    { legacy: 998, unique: 418 },
  ])('handles a complete fleet with cached bounded work: %j', async (shape) => {
    const state = fixture(shape);
    const proof = await prepareBillingCatalogRelease(state.input);
    expect(proof.revisions).toEqual([
      { name: 'current', gitSha: sha, imageDigest: digest(10) },
      { name: 'rollback', gitSha: previous.components.service.gitSha, imageDigest: digest(12) },
    ]);
    expect(proof.retiredRevisions).toHaveLength(shape.legacy);
    expect(state.deleted.has('current')).toBe(false);
    expect(state.deleted.has('rollback')).toBe(false);
    expect(state.metadataReads.size).toBe(422); // 420 observed digests plus the two release indexes.
    expect([...state.metadataReads.values()].every((count) => count === 1)).toBe(true);
    expect(state.stats()).toMatchObject({ activeDeletes: 0, activeMetadata: 0 });
    expect(state.stats().peakDeletes).toBe(4);
    expect(state.stats().peakMetadata).toBeLessThanOrEqual(4);
    expect(state.audit.map((entry) => entry.phase)).toEqual(['planned', 'verified']);
  });
  it.each([
    { runningJob: true },
    { unknownJob: true },
    { databaseJob: true },
    { failImage: true },
    { changedTraffic: true },
    { tagged: true },
  ])('rejects the full unsafe plan before the first retirement: %j', async (options) => {
    const state = fixture(options);
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow();
    expect(state.commands.some((args) => args.includes('delete'))).toBe(false);
    expect(state.stats()).toMatchObject({ activeDeletes: 0, activeMetadata: 0 });
  });
  it('rejects an incomplete or oversized revision inventory before deleting', async () => {
    const state = fixture({ legacy: 999 });
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow('revision inventory');
    expect(state.deleted.size).toBe(0);
  });
  it('rejects duplicate or malformed revision identities before deleting', async () => {
    const state = fixture();
    const duplicate = state.revisions[2];
    if (!duplicate) throw new Error('missing fixture revision');
    duplicate.metadata.name = 'current';
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow('revision metadata');
    expect(state.deleted.size).toBe(0);
  });
  it.each([
    'wrong-repository',
    'wrong-image',
    'wrong-source',
    'missing-source',
  ])('does not normalize a current release by source SHA alone: %s', async (scenario) => {
    const state = fixture();
    const current = state.revisions[0]?.spec.containers[0];
    if (!current) throw new Error('missing fixture current revision');
    if (scenario === 'wrong-repository')
      current.image = current.image.replace('/p/r/', '/other/r/');
    if (scenario === 'wrong-image') current.image = image(99);
    if (scenario === 'wrong-source')
      current.env = [{ name: 'NOODLE_BUILD_SHA', value: 'f'.repeat(40) }];
    if (scenario === 'missing-source') current.env = [];
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow(
      /current release|source identity/,
    );
    expect(state.deleted.size).toBe(0);
  });
  it('rejects mismatched captured rollback identity before commands can retire', async () => {
    const state = fixture();
    await expect(
      prepareBillingCatalogRelease({
        ...state.input,
        manifest: { ...manifest, previousReleaseId: 'other-release' },
      }),
    ).rejects.toThrow('previous release');
    expect(state.deleted.size).toBe(0);
  });
  it('stops scheduling cleanup on failure and drains already running work', async () => {
    const state = fixture({ legacy: 30, failDelete: true });
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow('command failed');
    expect(state.commands.filter((args) => args.includes('delete')).length).toBeLessThanOrEqual(4);
    expect(state.stats().activeDeletes).toBe(0);
  });
  it('refuses proof when a supposedly retired revision remains', async () => {
    const state = fixture({ remains: true });
    await expect(prepareBillingCatalogRelease(state.input)).rejects.toThrow(
      'remains after retirement',
    );
    expect(state.audit.map((entry) => entry.phase)).toEqual(['planned']);
  });
  it('checks the preparation deadline before dispatch and drains cleanup after expiry', async () => {
    const state = fixture({ legacy: 30, elapsedPerDelete: 100 });
    await expect(
      prepareBillingCatalogRelease({ ...state.input, deadlineMs: state.input.nowMs() - 1 }),
    ).rejects.toThrow('deadline');
    expect(state.commands).toHaveLength(0);
    await expect(
      prepareBillingCatalogRelease({ ...state.input, deadlineMs: state.input.nowMs() + 50 }),
    ).rejects.toThrow('deadline');
    expect(state.commands.filter((args) => args.includes('delete')).length).toBeLessThanOrEqual(4);
    expect(state.stats().activeDeletes).toBe(0);
  });
  it('timestamps the verified evidence after cleanup rather than before', async () => {
    const state = fixture({ elapsedPerDelete: 100 });
    const started = state.input.nowMs();
    const proof = await prepareBillingCatalogRelease(state.input);
    expect(Date.parse(proof.checkedAt)).toBe(started + 200);
  });
});

it('keeps a retry of the first reader upgrade on catalog 1 using its recorded predecessor', async () => {
  const state = fixture();
  const captured = {
    components: {
      service: {
        releaseId: manifest.releaseId,
        gitSha: sha,
        manifestChecksum: manifest.manifestChecksum,
        imageDigest: manifest.images.service,
        image: image(10),
      },
    },
  };
  const original = {
    ...manifest,
    releaseId: 'r1',
    gitSha: previous.components.service.gitSha,
    manifestChecksum: previous.components.service.manifestChecksum,
    images: { ...manifest.images, service: digest(100) },
  };
  const result = await prepareBillingCatalogRelease({
    ...state.input,
    previous: captured,
    loadPreviousRelease: async () => original,
  });
  expect(result).toBeUndefined();
  expect(state.commands.some((args) => args[0] === 'gcloud')).toBe(false);
  expect(captured.components.service.releaseId).toBe(manifest.releaseId);
});

it('binds a same-candidate activation retry to its original compatible rollback manifest', async () => {
  const state = fixture();
  const captured = {
    components: {
      service: {
        releaseId: manifest.releaseId,
        gitSha: sha,
        manifestChecksum: manifest.manifestChecksum,
        imageDigest: manifest.images.service,
        image: image(10),
      },
    },
  };
  const original = {
    ...manifest,
    releaseId: 'r1',
    gitSha: previous.components.service.gitSha,
    manifestChecksum: previous.components.service.manifestChecksum,
    images: { ...manifest.images, service: previous.components.service.imageDigest },
  };
  const result = await prepareBillingCatalogRelease({
    ...state.input,
    previous: captured,
    loadPreviousRelease: async () => original,
  });
  expect(result?.rollback).toMatchObject({ releaseId: 'r1', imageDigest: digest(12) });
});

it('fails a same-candidate retry before reads or mutation if the predecessor record is missing or wrong', async () => {
  const state = fixture();
  const captured = {
    components: {
      service: {
        releaseId: manifest.releaseId,
        gitSha: sha,
        manifestChecksum: manifest.manifestChecksum,
        imageDigest: manifest.images.service,
        image: image(10),
      },
    },
  };
  await expect(
    prepareBillingCatalogRelease({ ...state.input, previous: captured }),
  ).rejects.toThrow('previous release');
  await expect(
    prepareBillingCatalogRelease({
      ...state.input,
      previous: captured,
      loadPreviousRelease: async () => manifest,
    }),
  ).rejects.toThrow('previous release');
  expect(state.commands).toHaveLength(0);
});

it('keeps a fresh forward recovery on catalog 1 when its finalized predecessor is reader 1', async () => {
  const state = fixture();
  const captured = {
    components: { service: { ...previous.components.service, releaseId: 'failed-unfinalized' } },
  };
  const original = {
    ...manifest,
    releaseId: 'r1',
    gitSha: previous.components.service.gitSha,
    manifestChecksum: previous.components.service.manifestChecksum,
    images: { ...manifest.images, service: digest(100) },
  };
  const result = await prepareBillingCatalogRelease({
    ...state.input,
    previous: captured,
    loadPreviousRelease: async () => original,
  });
  expect(result).toBeUndefined();
  expect(state.metadataReads.has(image(12))).toBe(true);
  expect(state.metadataReads.has(image(100))).toBe(true);
  expect(state.commands.some((args) => args[0] === 'gcloud')).toBe(false);
});

it('rejects a compatible recorded predecessor when the actual captured rollback remains reader 1', async () => {
  const state = fixture();
  const captured = {
    components: {
      service: {
        ...previous.components.service,
        releaseId: 'failed-unfinalized',
        imageDigest: digest(100),
        image: image(100),
      },
    },
  };
  const original = {
    ...manifest,
    releaseId: 'r1',
    gitSha: previous.components.service.gitSha,
    manifestChecksum: previous.components.service.manifestChecksum,
    images: { ...manifest.images, service: digest(12) },
  };
  await expect(
    prepareBillingCatalogRelease({
      ...state.input,
      previous: captured,
      loadPreviousRelease: async () => original,
    }),
  ).rejects.toThrow('captured rollback');
  expect(state.commands.some((args) => args[0] === 'gcloud')).toBe(false);
});

it('keeps three recovery release indexes within a full 1000-image inventory bound', async () => {
  const state = fixture({ legacy: 998, unique: 998 });
  const capturedRevision = state.revisions[2];
  if (!capturedRevision) throw new Error('missing captured fixture revision');
  capturedRevision.metadata.name = 'captured-unfinalized';
  capturedRevision.spec.containers = [
    { image: image(15), env: [{ name: 'NOODLE_BUILD_SHA', value: 'f'.repeat(40) }] },
  ];
  const captured = {
    components: {
      service: {
        ...previous.components.service,
        releaseId: 'failed-unfinalized',
        gitSha: 'f'.repeat(40),
        imageDigest: digest(14),
        image: image(14),
      },
    },
  };
  const original = {
    ...manifest,
    releaseId: 'r1',
    gitSha: previous.components.service.gitSha,
    manifestChecksum: previous.components.service.manifestChecksum,
    images: { ...manifest.images, service: digest(12) },
  };
  const result = await prepareBillingCatalogRelease({
    ...state.input,
    previous: captured,
    loadPreviousRelease: async () => original,
  });
  expect(result?.retiredRevisions).toHaveLength(997);
  expect(state.metadataReads.size).toBe(1003);
  expect(state.deleted.has('captured-unfinalized')).toBe(false);
  expect(result?.rollback.releaseId).toBe('r1');
});

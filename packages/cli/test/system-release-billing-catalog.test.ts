import { describe, expect, it, vi } from 'vitest';
import {
  activateBillingCatalogRelease,
  prepareBillingCatalogRelease,
} from '../../../scripts/lib/system-release-billing-catalog.mjs';
import { createImageMetadataResolver } from '../../../scripts/lib/system-release-image-metadata.mjs';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const sha = 'a'.repeat(40);
const registry = 'us-docker.pkg.dev/p/r';
const image = (c: string) => `${registry}/service@${digest(c)}`;
const config = {
  project: 'p',
  region: 'us',
  artifactsProject: 'p',
  repository: 'r',
  service: 'service',
  builder: 'builder',
  publicBaseUrl: 'https://service.example',
  workloadAudience: 'audience',
};
const manifest = {
  releaseId: 'r2',
  previousReleaseId: 'r1',
  gitSha: sha,
  manifestChecksum: digest('e'),
  images: { service: digest('b'), githubBuilder: digest('e') },
};
const previous = {
  components: {
    service: {
      releaseId: 'r1',
      gitSha: 'c'.repeat(40),
      manifestChecksum: digest('f'),
      imageDigest: digest('c'),
      image: image('c'),
    },
  },
};
function setup(
  options: { oldRollback?: boolean; tag?: boolean; remains?: boolean; runningJob?: boolean } = {},
) {
  let deleted = false;
  const revision = (c: string) => ({
    metadata: { name: `service-${c}` },
    spec: {
      containers: [
        {
          image: image(c),
          env: [{ name: 'NOODLE_BUILD_SHA', value: c === 'b' ? sha : 'c'.repeat(40) }],
        },
      ],
    },
  });
  const execute = vi.fn((command: string, args: string[]) => {
    const call = args.join(' ');
    if (command === 'docker') {
      if (args.includes('--raw'))
        return JSON.stringify({
          schemaVersion: 2,
          mediaType: 'application/vnd.oci.image.manifest.v1+json',
          config: { digest: digest('a') },
          layers: [],
        });
      return JSON.stringify({
        os: 'linux',
        architecture: 'amd64',
        config: {
          Labels:
            args.at(-1) === image('d') || (args.at(-1) === image('c') && options.oldRollback)
              ? null
              : { 'io.noodleseed.billing-catalog-reader': '2' },
        },
      });
    }
    if (call.startsWith('run revisions list'))
      return JSON.stringify([
        revision('b'),
        ...(!deleted || options.remains ? [revision('d')] : []),
      ]);
    if (call.startsWith('run services describe'))
      return JSON.stringify({
        status: {
          traffic: [
            { revisionName: 'service-b', percent: 100 },
            ...(options.tag ? [{ revisionName: 'service-d', tag: 'legacy' }] : []),
          ],
        },
      });
    if (call.startsWith('run revisions delete')) {
      deleted = true;
      return '';
    }
    if (call.startsWith('run jobs describe'))
      return JSON.stringify({
        spec: {
          template: {
            spec: {
              template: {
                spec: { containers: [{ image: `${registry}/github-builder@${digest('e')}` }] },
              },
            },
          },
        },
      });
    if (call.startsWith('run jobs list'))
      return JSON.stringify([{ metadata: { name: 'builder' } }]);
    if (call.startsWith('run jobs executions list'))
      return JSON.stringify(options.runningJob ? [{ status: { runningCount: 1 } }] : []);
    throw new Error(`unexpected ${command} ${call}`);
  });
  const executeAsync = async (command: string, args: string[]) => execute(command, args);
  return { execute, executeAsync, resolveImageMetadata: createImageMetadataResolver(executeAsync) };
}
describe('protected billing catalog release', () => {
  it('mints a fresh token at activation and does not expose it in the response', () => {
    const mintIdentityToken = vi.fn(() => 'fresh-billing-token');
    const result = { ok: true, data: { version: 2, revision: digest('b') } };
    const execute = vi.fn((_command: string, _args: string[]) => JSON.stringify(result));
    expect(
      activateBillingCatalogRelease({
        proof: { checked: true },
        config,
        execute,
        mintIdentityToken,
      }),
    ).toEqual(result.data);
    expect(mintIdentityToken).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toContain('Authorization: Bearer fresh-billing-token');
  });
  it('does not call the activation API if fresh token generation fails', () => {
    const execute = vi.fn();
    const mintIdentityToken = () => {
      throw new Error('release workload identity token generation failed');
    };
    expect(() =>
      activateBillingCatalogRelease({ proof: {}, config, execute, mintIdentityToken }),
    ).toThrow('identity token generation failed');
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not leak a bearer token through a failed activation command', () => {
    const execute = () => {
      throw new Error('curl Authorization: Bearer private-token');
    };
    expect(() =>
      activateBillingCatalogRelease({
        proof: {},
        config,
        execute,
        mintIdentityToken: () => 'private-token',
      }),
    ).toThrow(/^billing catalog activation request failed$/);
  });
  it('leaves catalog unchanged during the first compatible reader release', async () => {
    const fixture = setup({ oldRollback: true });
    expect(
      await prepareBillingCatalogRelease({ manifest, previous, config, ...fixture }),
    ).toBeUndefined();
    expect(fixture.execute.mock.calls.some(([, args]) => args.includes('delete'))).toBe(false);
  });
  it('retires only idle incompatible revisions and proves absence before constructing evidence', async () => {
    const fixture = setup();
    expect(
      await prepareBillingCatalogRelease({ manifest, previous, config, ...fixture }),
    ).toMatchObject({
      schemaVersion: 1,
      retiredRevisions: ['service-d'],
      revisions: [{ name: 'service-b', gitSha: sha }],
      rollback: { releaseId: 'r1' },
      jobs: [{ activeExecutions: 0 }],
    });
  });
  it.each([
    { tag: true },
    { remains: true },
    { runningJob: true },
  ])('fails closed for incomplete drain %j', async (options) => {
    await expect(
      prepareBillingCatalogRelease({ manifest, previous, config, ...setup(options) }),
    ).rejects.toThrow();
  });
  it('rejects mutable image names and never invents metadata', async () => {
    const execute = vi.fn();
    await expect(createImageMetadataResolver(execute)('service:latest')).rejects.toThrow(
      'immutable',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not call the activation API for a readers-only release', () => {
    const execute = vi.fn();
    expect(activateBillingCatalogRelease({ proof: undefined, config, execute })).toEqual({
      version: 1,
      readersOnly: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});

it('validates running jobs before retiring any historical revision', async () => {
  const fixture = setup({ runningJob: true });
  await expect(
    prepareBillingCatalogRelease({ manifest, previous, config, ...fixture }),
  ).rejects.toThrow('executions');
  expect(fixture.execute.mock.calls.filter(([, args]) => args.includes('delete'))).toHaveLength(0);
});

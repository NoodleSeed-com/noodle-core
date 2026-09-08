import { describe, expect, it, vi } from 'vitest';
import {
  activateBillingCatalogRelease,
  prepareBillingCatalogRelease,
  readBillingCatalogImageReader,
} from '../../../scripts/lib/system-release-billing-catalog.mjs';

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
    if (command === 'docker')
      return args[0] === 'pull'
        ? ''
        : JSON.stringify([
            {
              Config: {
                Labels:
                  args[2] === image('d') || (args[2] === image('c') && options.oldRollback)
                    ? {}
                    : { 'io.noodleseed.billing-catalog-reader': '2' },
              },
            },
          ]);
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
  return { execute };
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
  it('leaves catalog unchanged during the first compatible reader release', () => {
    const { execute } = setup({ oldRollback: true });
    expect(prepareBillingCatalogRelease({ manifest, previous, config, execute })).toBeUndefined();
    expect(execute.mock.calls.some(([, args]) => args.includes('delete'))).toBe(false);
  });
  it('retires only idle incompatible revisions and proves absence before constructing evidence', () => {
    const { execute } = setup();
    expect(prepareBillingCatalogRelease({ manifest, previous, config, execute })).toMatchObject({
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
  ])('fails closed for incomplete drain %j', (options) => {
    expect(() =>
      prepareBillingCatalogRelease({ manifest, previous, config, ...setup(options) }),
    ).toThrow();
  });
  it('rejects mutable image names and never invents metadata', () => {
    const execute = vi.fn();
    expect(() => readBillingCatalogImageReader('service:latest', execute)).toThrow('immutable');
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

import { describe, expect, it, vi } from 'vitest';
import {
  createImageMetadataResolver,
  executeReleaseCommandAsync,
} from '../../../scripts/lib/system-release-image-metadata.mjs';

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const image = (c: string) => `us-docker.pkg.dev/p/r/service@${digest(c)}`;
const manifest = {
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  config: { digest: digest('f') },
  layers: [],
};
const index = {
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.index.v1+json',
  manifests: [
    {
      digest: digest('b'),
      mediaType: manifest.mediaType,
      platform: { os: 'linux', architecture: 'amd64' },
    },
    {
      digest: digest('c'),
      mediaType: manifest.mediaType,
      platform: { os: 'unknown', architecture: 'unknown' },
      annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
    },
  ],
};
function executor(
  raw: unknown = index,
  config: unknown = {
    os: 'linux',
    architecture: 'amd64',
    config: { Labels: { 'io.noodleseed.billing-catalog-reader': '2' } },
  },
) {
  return vi.fn(
    async (
      command: string,
      args: string[],
      limits: { timeoutMs: number; maxOutputBytes: number },
    ) => {
      expect(command).toBe('docker');
      expect(args.slice(0, 3)).toEqual(['buildx', 'imagetools', 'inspect']);
      expect(limits).toEqual({ timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 });
      return JSON.stringify(args[3] === '--raw' ? raw : config);
    },
  );
}

describe('immutable release image metadata', () => {
  it('resolves an attested index to its exact runnable child without pulling layers', async () => {
    const execute = executor();
    const resolve = createImageMetadataResolver(execute);
    expect(await resolve(image('a'))).toEqual({
      image: image('a'),
      manifestDigest: digest('a'),
      platformDigest: digest('b'),
      readerVersion: 2,
    });
    expect(execute.mock.calls[1]?.[1]).toEqual([
      'buildx',
      'imagetools',
      'inspect',
      '--format',
      '{{json .Image}}',
      image('b'),
    ]);
    expect(execute.mock.calls.flat(2)).not.toContain('pull');
  });
  it.each([
    undefined,
    null,
    {},
  ])('accepts absent or null historical labels only after valid metadata (%j)', async (labels) => {
    const resolve = createImageMetadataResolver(
      executor(manifest, { os: 'linux', architecture: 'amd64', config: { Labels: labels } }),
    );
    expect(await resolve(image('a'))).toMatchObject({
      platformDigest: digest('a'),
      readerVersion: 1,
    });
  });
  it('coalesces concurrent references and caches successful complete immutable references', async () => {
    const execute = executor();
    const resolve = createImageMetadataResolver(execute);
    const values = await Promise.all(Array.from({ length: 20 }, () => resolve(image('a'))));
    expect(values).toHaveLength(20);
    expect(execute).toHaveBeenCalledTimes(2);
    await resolve(image('a'));
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('bounds parallel metadata reads to four subprocesses', async () => {
    let active = 0;
    let peak = 0;
    const execute = async (_command: string, args: string[]) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return JSON.stringify(
        args[3] === '--raw'
          ? manifest
          : { os: 'linux', architecture: 'amd64', config: { Labels: null } },
      );
    };
    const resolve = createImageMetadataResolver(execute);
    await Promise.all('0123456789'.split('').map((c) => resolve(image(c))));
    expect(peak).toBeLessThanOrEqual(4);
  });
  it.each([
    'service:latest',
    `${image('a')}:latest`,
    `https://${image('a')}`,
  ])('rejects noncanonical immutable references before commands: %s', async (value) => {
    const execute = executor();
    await expect(createImageMetadataResolver(execute)(value)).rejects.toThrow('immutable');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    { ...index, manifests: [] },
    { ...index, manifests: [index.manifests[0], index.manifests[0]] },
    { ...index, manifests: [{ ...index.manifests[0], digest: 'sha256:invalid' }] },
    { schemaVersion: 1 },
    { ...manifest, config: {} },
  ])('rejects malformed or ambiguous registry manifests', async (raw) => {
    await expect(createImageMetadataResolver(executor(raw))(image('a'))).rejects.toThrow(
      'metadata',
    );
  });
  it.each([
    { os: 'linux', architecture: 'arm64', config: {} },
    {
      os: 'linux',
      architecture: 'amd64',
      config: { Labels: { 'io.noodleseed.billing-catalog-reader': '3' } },
    },
    { os: 'linux', architecture: 'amd64' },
    { 'linux/amd64': { os: 'linux', architecture: 'amd64', config: {} } },
  ])('fails closed on unsupported or malformed exact-child configuration', async (config) => {
    await expect(
      createImageMetadataResolver(executor(manifest, config))(image('a')),
    ).rejects.toThrow('metadata');
  });
  it('does not leak authenticated command output and allows an explicit retry after failure', async () => {
    const execute = executor();
    execute.mockRejectedValueOnce(new Error('Authorization: Bearer private-token'));
    const resolve = createImageMetadataResolver(execute);
    await expect(resolve(image('a'))).rejects.toThrow(/^release image metadata unavailable:/);
    await expect(resolve(image('a'))).resolves.toMatchObject({ readerVersion: 2 });
  });
});

describe('bounded release subprocess execution', () => {
  it('captures successful stdout', async () => {
    expect(
      await executeReleaseCommandAsync(process.execPath, ['-e', 'process.stdout.write("ok")'], {
        timeoutMs: 1000,
        maxOutputBytes: 1024,
      }),
    ).toBe('ok');
  });
  it.each([
    {
      program: 'process.stderr.write("private-token"); process.exit(1)',
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      reason: 'execution failed',
    },
    {
      program: 'setInterval(() => {}, 1000)',
      timeoutMs: 20,
      maxOutputBytes: 1024,
      reason: 'timeout',
    },
    {
      program: 'process.stdout.write("private-token".repeat(1000))',
      timeoutMs: 1000,
      maxOutputBytes: 20,
      reason: 'output limit',
    },
  ])('rejects bounded subprocess failure without raw output ($reason)', async ({
    program,
    reason,
    ...limits
  }) => {
    await expect(
      executeReleaseCommandAsync(process.execPath, ['-e', program], limits),
    ).rejects.toThrow(reason);
    await expect(
      executeReleaseCommandAsync(process.execPath, ['-e', program], limits),
    ).rejects.not.toThrow('private-token');
  });
});

it('caps each metadata dispatch to the remaining phase budget and skips config after expiry', async () => {
  let now = 1000;
  const calls: Array<{ args: string[]; timeoutMs: number }> = [];
  const resolve = createImageMetadataResolver(
    async (_command: string, args: string[], limits: { timeoutMs: number }) => {
      calls.push({ args, timeoutMs: limits.timeoutMs });
      now += 60;
      return JSON.stringify(index);
    },
  );
  await expect(resolve(image('a'), { deadlineMs: 1050, nowMs: () => now })).rejects.toThrow(
    'deadline',
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.timeoutMs).toBe(50);
});

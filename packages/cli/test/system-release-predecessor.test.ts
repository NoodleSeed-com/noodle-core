import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readRecordedPredecessor } from '../../../scripts/lib/system-release-predecessor.mjs';
import { validateReleaseManifest } from '../../../scripts/system-release-manifest.mjs';

function record() {
  const manifest = validateReleaseManifest({
    schemaVersion: 1,
    releaseId: 'r907',
    gitSha: 'a'.repeat(40),
    createdAt: '2026-09-06T00:00:00.000Z',
    previousReleaseId: null,
    images: Object.fromEntries(
      ['service', 'githubBuilder', 'website', 'docs', 'console'].map((name) => [
        name,
        `sha256:${'b'.repeat(64)}`,
      ]),
    ),
    packages: {
      '@noodleseed/one': '0.162.0',
      '@noodleseed/agent-kit': '0.100.0',
      '@noodleseed/assistant': '1.35.1',
    },
  });
  return {
    ...manifest,
    manifestChecksum: `sha256:${createHash('sha256')
      .update(`${JSON.stringify(manifest)}\n`)
      .digest('hex')}`,
  };
}

describe('recorded predecessor on a release retry', () => {
  it('reads only the named release asset and validates its identity and checksum', async () => {
    const executeAsync = vi.fn(async () => JSON.stringify(record()));
    await expect(
      readRecordedPredecessor({
        repository: 'NoodleSeed-com/noodle-borg',
        releaseId: 'r907',
        executeAsync,
        deadlineMs: 2000,
        nowMs: () => 1000,
      }),
    ).resolves.toEqual(record());
    expect(executeAsync).toHaveBeenCalledWith(
      'gh',
      [
        'release',
        'download',
        'system-r907',
        '--repo',
        'NoodleSeed-com/noodle-borg',
        '--pattern',
        'system-release.json',
        '--output',
        '-',
      ],
      { timeoutMs: 1000, maxOutputBytes: 1024 * 1024 },
    );
  });
  it.each([
    'missing checksum',
    'wrong release',
    'tampered',
    'not JSON',
  ])('refuses an invalid recorded predecessor: %s', async (reason) => {
    const manifest = record();
    const value =
      reason === 'missing checksum'
        ? { ...manifest, manifestChecksum: undefined }
        : reason === 'wrong release'
          ? { ...manifest, releaseId: 'r908' }
          : reason === 'tampered'
            ? { ...manifest, gitSha: 'c'.repeat(40) }
            : undefined;
    await expect(
      readRecordedPredecessor({
        repository: 'NoodleSeed-com/noodle-borg',
        releaseId: 'r907',
        executeAsync: async () => (value ? JSON.stringify(value) : 'invalid'),
      }),
    ).rejects.toThrow('recorded billing predecessor is unavailable');
  });
  it('refuses unbounded inputs or an exhausted budget before requesting credentials', async () => {
    const executeAsync = vi.fn();
    for (const input of [
      { repository: '', releaseId: 'r907' },
      { repository: 'owner/repo', releaseId: '--latest' },
      { repository: 'owner/repo', releaseId: 'r907', deadlineMs: 1000, nowMs: () => 1000 },
    ])
      await expect(readRecordedPredecessor({ ...input, executeAsync })).rejects.toThrow();
    expect(executeAsync).not.toHaveBeenCalled();
  });
  it('sanitizes authenticated download errors', async () => {
    await expect(
      readRecordedPredecessor({
        repository: 'owner/repo',
        releaseId: 'r907',
        executeAsync: async () => {
          throw new Error('Authorization: Bearer secret');
        },
      }),
    ).rejects.toThrow(/^recorded billing predecessor is unavailable$/);
  });
});

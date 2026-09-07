import { describe, expect, it } from 'vitest';
import { diagnoseSystemPackages } from '../../../scripts/release-doctor.mjs';

const manifest = {
  schemaVersion: 3,
  packages: {
    '@noodleseed/one': {
      version: '0.36.0',
      tag: 'v0.36.0',
      sourceSha: 'a'.repeat(40),
      integrity: `sha512-${'A'.repeat(86)}==`,
      treeHash: `sha256:${'b'.repeat(64)}`,
    },
  },
};

const observed = {
  '@noodleseed/one': {
    npmVersion: '0.36.0',
    npmLatest: '0.36.0',
    npmIntegrity: manifest.packages['@noodleseed/one'].integrity,
    tagSha: manifest.packages['@noodleseed/one'].sourceSha,
  },
};

describe('system release doctor', () => {
  it('accepts one finalized manifest as the release authority', () => {
    expect(diagnoseSystemPackages(manifest, observed)).toEqual([]);
  });

  it('reports npm and tag drift without proposing a mutation', () => {
    const failures = diagnoseSystemPackages(manifest, {
      '@noodleseed/one': {
        ...observed['@noodleseed/one'],
        npmLatest: '0.35.0',
        npmIntegrity: `sha512-${'B'.repeat(86)}==`,
        tagSha: 'c'.repeat(40),
      },
    });
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/npm latest/i),
        expect.stringMatching(/integrity/i),
        expect.stringMatching(/tag/i),
      ]),
    );
  });
});

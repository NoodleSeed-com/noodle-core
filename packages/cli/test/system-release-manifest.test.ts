import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../../scripts/lib/npm-artifact-policy.mjs';
import {
  createCandidateManifest,
  finalizeReleaseManifest,
  parseSystemReleaseId,
  validateReleaseManifest,
} from '../../../scripts/system-release-manifest.mjs';

const digests = {
  service: `sha256:${'a'.repeat(64)}`,
  githubBuilder: `sha256:${'b'.repeat(64)}`,
  website: `sha256:${'c'.repeat(64)}`,
  docs: `sha256:${'d'.repeat(64)}`,
  console: `sha256:${'e'.repeat(64)}`,
  portal: `sha256:${'f'.repeat(64)}`,
  calendarAdapter: `sha256:${'9'.repeat(64)}`,
};
const legacyDigests = Object.fromEntries(
  Object.entries(digests).filter(([name]) => !['portal', 'calendarAdapter'].includes(name)),
);

const packages = {
  '@noodleseed/one': {
    version: '0.34.0',
    tag: 'v0.34.0',
    sourceSha: '1'.repeat(40),
    integrity: `sha512-${'A'.repeat(86)}==`,
    treeHash: `sha256:${'a'.repeat(64)}`,
  },
  '@noodleseed/agent-kit': {
    version: '0.20.0',
    tag: 'agent-kit-v0.20.0',
    sourceSha: '1'.repeat(40),
    integrity: `sha512-${'B'.repeat(86)}==`,
    treeHash: `sha256:${'b'.repeat(64)}`,
  },
  '@noodleseed/assistant': {
    version: '1.0.0',
    tag: 'assistant-v1.0.0',
    sourceSha: '1'.repeat(40),
    integrity: `sha512-${'C'.repeat(86)}==`,
    treeHash: `sha256:${'c'.repeat(64)}`,
  },
};

const pluginMarketplace = {
  pluginVersion: '0.20.0',
  agentKitVersion: '0.20.0',
  cliVersion: '0.34.0',
  developerMcpCapabilityVersion: '1',
  sourceSha: '1'.repeat(40),
  contentHash: `sha256:${'f'.repeat(64)}`,
  treeHash: `sha256:${'d'.repeat(64)}`,
  archiveIntegrity: `sha512-${'D'.repeat(86)}==`,
};

const copilotPlugin = {
  ...pluginMarketplace,
  treeHash: `sha256:${'e'.repeat(64)}`,
  archiveIntegrity: `sha512-${'E'.repeat(86)}==`,
};

function npmReportBytes(
  overrides: Partial<{
    version: string;
    source: 'candidate' | 'inherited-npm';
    tarballIntegrity: string;
    treeHash: string;
    findings: Array<{ id: string; class: string; path: string; package: string }>;
  }> = {},
) {
  const findings = overrides.findings ?? [];
  const artifact = {
    component: 'cli',
    package: '@noodleseed/one',
    version: overrides.version ?? packages['@noodleseed/one'].version,
    source: overrides.source ?? 'candidate',
    tarball: 'release-packages/noodleseed-one-0.34.0.tgz',
    policySha256: `sha256:${'1'.repeat(64)}`,
    tarballIntegrity: overrides.tarballIntegrity ?? packages['@noodleseed/one'].integrity,
    treeHash: overrides.treeHash ?? packages['@noodleseed/one'].treeHash,
    fileListHash: `sha256:${'2'.repeat(64)}`,
    packages: [],
    archiveBytes: 1,
    unpackedBytes: 1,
    archiveEntries: 1,
    fileCount: 1,
    findings,
    clean: findings.length === 0,
  };
  const report = {
    schemaVersion: 1,
    policySha256: artifact.policySha256,
    artifacts: [artifact],
    clean: artifact.clean,
  };
  return Buffer.from(`${canonicalJson(report)}\n`);
}

const npmArtifactReportBytes = npmReportBytes();

describe('system release manifests', () => {
  it('creates a complete staging candidate by carrying forward unchanged immutable digests', () => {
    const candidate = createCandidateManifest({
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      previous: {
        schemaVersion: 1,
        releaseId: 'r41',
        gitSha: '0'.repeat(40),
        createdAt: '2026-07-11T00:00:00.000Z',
        images: legacyDigests,
        packages: {
          '@noodleseed/one': '0.33.0',
          '@noodleseed/agent-kit': '0.20.0',
          '@noodleseed/assistant': '1.0.0',
        },
        previousReleaseId: null,
      },
      imageUpdates: {
        website: `sha256:${'9'.repeat(64)}`,
        portal: digests.portal,
        calendarAdapter: digests.calendarAdapter,
      },
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });

    expect(candidate.releaseId).toBeNull();
    expect(candidate.schemaVersion).toBe(7);
    expect(candidate.pluginMarketplace).toEqual(pluginMarketplace);
    expect(candidate.copilotPlugin).toEqual(copilotPlugin);
    expect(candidate.previousReleaseId).toBe('r41');
    expect(candidate.images.service).toBe(digests.service);
    expect(candidate.images.website).toBe(`sha256:${'9'.repeat(64)}`);
    expect(candidate.compatibility['@noodleseed/one']).toEqual(['0.33.0', '0.34.0']);
  });

  it('fails closed when no complete image set can be resolved', () => {
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: { service: digests.service },
        packages,
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/missing image digest/i);
  });

  it('finalizes a candidate with a monotonic release id and stable checksum', () => {
    const candidate = createCandidateManifest({
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      previous: null,
      imageUpdates: digests,
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });
    const first = finalizeReleaseManifest(candidate, 'r142');
    const second = finalizeReleaseManifest(candidate, 'r142');

    expect(first.manifestChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first).toEqual(second);
    expect(validateReleaseManifest(first)).toEqual(first);
  });

  it('rejects package records without an immutable npm integrity', () => {
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages: {
          ...packages,
          '@noodleseed/one': { ...packages['@noodleseed/one'], integrity: '' },
        },
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/integrity/i);
  });

  it('requires stable SemVer and a component tag for that exact version', () => {
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages: {
          ...packages,
          '@noodleseed/one': { ...packages['@noodleseed/one'], version: '0.34.0-rc.1' },
        },
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/version/i);

    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages: {
          ...packages,
          '@noodleseed/one': { ...packages['@noodleseed/one'], tag: 'v9.9.9' },
        },
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/tag/i);
  });

  it('rejects leading-zero SemVer only for new schema v6 surfaces', () => {
    const legacy = {
      schemaVersion: 5,
      releaseId: 'r41',
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      images: legacyDigests,
      packages: {
        ...packages,
        '@noodleseed/one': { ...packages['@noodleseed/one'], version: '00.34.0', tag: 'v00.34.0' },
      },
      pluginMarketplace,
      copilotPlugin,
      compatibility: {
        '@noodleseed/one': ['00.34.0'],
        '@noodleseed/agent-kit': ['0.20.0'],
        '@noodleseed/assistant': ['1.0.0'],
      },
      previousReleaseId: null,
    };
    expect(validateReleaseManifest(legacy)).toEqual(legacy);
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages: legacy.packages,
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes: npmReportBytes({ version: '00.34.0' }),
      }),
    ).toThrow(/version/i);
  });

  it('accepts only canonical positive r-numbers', () => {
    expect(parseSystemReleaseId('r142')).toBe(142);
    for (const value of ['r0', 'r01', '142', 'system-r142', 'r-1']) {
      expect(() => parseSystemReleaseId(value)).toThrow(/release id/i);
    }
  });

  it('retains validation for finalized manifest schemas v1 through v5', () => {
    const compatibility = Object.fromEntries(
      Object.entries(packages).map(([name, entry]) => [name, [entry.version]]),
    );
    const legacyPackages = Object.fromEntries(
      Object.entries(packages).map(
        ([name, { sourceSha: _sourceSha, treeHash: _treeHash, ...entry }]) => [name, entry],
      ),
    );
    const common = {
      releaseId: 'r41',
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      images: legacyDigests,
      previousReleaseId: null,
    };
    const {
      agentKitVersion: _agentKitVersion,
      contentHash: _contentHash,
      ...legacyPlugin
    } = pluginMarketplace;
    const historical = [
      {
        ...common,
        schemaVersion: 1,
        packages: Object.fromEntries(
          Object.entries(packages).map(([name, entry]) => [name, entry.version]),
        ),
      },
      { ...common, schemaVersion: 2, packages: legacyPackages, compatibility },
      { ...common, schemaVersion: 3, packages, compatibility },
      { ...common, schemaVersion: 4, packages, compatibility, pluginMarketplace: legacyPlugin },
      {
        ...common,
        schemaVersion: 5,
        packages,
        compatibility,
        pluginMarketplace,
        copilotPlugin,
      },
    ];

    for (const manifest of historical) {
      expect(validateReleaseManifest(manifest)).toEqual(manifest);
    }
  });

  it('keeps schema v3 finalized manifests readable and requires both projections for v5 candidates', () => {
    const legacy = {
      schemaVersion: 3,
      releaseId: 'r41',
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      images: legacyDigests,
      packages,
      compatibility: Object.fromEntries(
        Object.entries(packages).map(([name, entry]) => [name, [entry.version]]),
      ),
      previousReleaseId: null,
    };
    expect(validateReleaseManifest(legacy)).toEqual(legacy);
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: legacy,
        imageUpdates: { portal: digests.portal, calendarAdapter: digests.calendarAdapter },
        packages,
        npmArtifactReportBytes,
      }),
    ).toThrow(/plugin marketplace/i);

    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: legacy,
        imageUpdates: { portal: digests.portal, calendarAdapter: digests.calendarAdapter },
        packages,
        pluginMarketplace,
        npmArtifactReportBytes,
      }),
    ).toThrow(/Copilot plugin/i);
  });

  it('keeps existing schema v4 manifests readable but requires complete provenance for new candidates', () => {
    const candidate = createCandidateManifest({
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      previous: null,
      imageUpdates: digests,
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });
    const finalized = finalizeReleaseManifest(candidate, 'r42');
    const legacyPlugin = { ...finalized.pluginMarketplace };
    delete legacyPlugin.contentHash;
    delete legacyPlugin.agentKitVersion;
    const legacyBase = {
      ...finalized,
      schemaVersion: 4,
      images: legacyDigests,
      pluginMarketplace: legacyPlugin,
    };
    const {
      manifestChecksum: _checksum,
      copilotPlugin: _copilotPlugin,
      ...withoutChecksum
    } = legacyBase;
    expect(validateReleaseManifest(withoutChecksum).pluginMarketplace).toEqual(legacyPlugin);

    const { contentHash: _contentHash, ...missingContentHash } = pluginMarketplace;
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages,
        pluginMarketplace: missingContentHash,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/contentHash/i);
  });

  it('requires both projection records to agree on shared release provenance', () => {
    const mismatches = {
      pluginVersion: '9.9.9',
      agentKitVersion: '9.9.9',
      cliVersion: '9.9.9',
      developerMcpCapabilityVersion: '2',
      sourceSha: '2'.repeat(40),
      contentHash: `sha256:${'0'.repeat(64)}`,
    };

    for (const [field, value] of Object.entries(mismatches)) {
      expect(() =>
        createCandidateManifest({
          gitSha: '1'.repeat(40),
          createdAt: '2026-07-12T00:00:00.000Z',
          previous: null,
          imageUpdates: digests,
          packages,
          pluginMarketplace,
          copilotPlugin: { ...copilotPlugin, [field]: value },
          npmArtifactReportBytes,
        }),
      ).toThrow(new RegExp(field, 'i'));
    }
  });

  it('requires exact canonical npm artifact report bytes and binds normalized CLI evidence', () => {
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages,
        pluginMarketplace,
        copilotPlugin,
      }),
    ).toThrow(/npm artifact report/i);

    const candidate = createCandidateManifest({
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      previous: null,
      imageUpdates: digests,
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });
    expect(candidate.npmArtifacts).toEqual({
      schemaVersion: 1,
      report: 'npm-artifact-report.json',
      reportSha256: 'sha256:e8b2e2cc87b5035031c00f12f5ed28854313d14c14888996de1f34cc22b9b5c8',
      policySha256: `sha256:${'1'.repeat(64)}`,
      cli: {
        package: '@noodleseed/one',
        version: '0.34.0',
        source: 'candidate',
        tarball: 'release-packages/noodleseed-one-0.34.0.tgz',
        tarballIntegrity: packages['@noodleseed/one'].integrity,
        treeHash: packages['@noodleseed/one'].treeHash,
        fileListHash: `sha256:${'2'.repeat(64)}`,
        findingCount: 0,
        findingInventoryDigest:
          'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
        clean: true,
      },
    });

    const pretty = Buffer.from(
      `${JSON.stringify(JSON.parse(npmArtifactReportBytes.toString()), null, 2)}\n`,
    );
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages,
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes: pretty,
      }),
    ).toThrow(/canonical/i);
  });

  it('rejects report/package disagreement and preserves v6 evidence through finalization', () => {
    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages,
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes: npmReportBytes({ treeHash: `sha256:${'9'.repeat(64)}` }),
      }),
    ).toThrow(/treeHash/i);

    expect(() =>
      createCandidateManifest({
        gitSha: '1'.repeat(40),
        createdAt: '2026-07-12T00:00:00.000Z',
        previous: null,
        imageUpdates: digests,
        packages: {
          ...packages,
          '@noodleseed/one': { ...packages['@noodleseed/one'], hiddenClaim: 'ignored' },
        },
        pluginMarketplace,
        copilotPlugin,
        npmArtifactReportBytes,
      }),
    ).toThrow(/package record.*exactly/i);

    const candidate = createCandidateManifest({
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      previous: null,
      imageUpdates: digests,
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });
    const finalized = finalizeReleaseManifest(candidate, 'r99');
    expect(finalized.npmArtifacts).toEqual(candidate.npmArtifacts);
    expect(Object.keys(finalized)).toEqual([
      'schemaVersion',
      'releaseId',
      'gitSha',
      'createdAt',
      'images',
      'packages',
      'pluginMarketplace',
      'copilotPlugin',
      'npmArtifacts',
      'compatibility',
      'previousReleaseId',
      'manifestChecksum',
    ]);
    expect(() =>
      validateReleaseManifest({
        ...finalized,
        npmArtifacts: {
          ...finalized.npmArtifacts,
          cli: { ...finalized.npmArtifacts.cli, treeHash: `sha256:${'9'.repeat(64)}` },
        },
      }),
    ).toThrow(/treeHash/i);
  });

  it('preserves fixed producer-order checksum fixtures for historical schemas v4 through v6', () => {
    const compatibility = Object.fromEntries(
      Object.entries(packages).map(([name, entry]) => [name, [entry.version]]),
    );
    const common = {
      releaseId: null,
      gitSha: '1'.repeat(40),
      createdAt: '2026-07-12T00:00:00.000Z',
      images: legacyDigests,
      packages,
    };
    const {
      agentKitVersion: _agentKitVersion,
      contentHash: _contentHash,
      ...legacyPlugin
    } = pluginMarketplace;
    const v4 = finalizeReleaseManifest(
      {
        ...common,
        schemaVersion: 4,
        pluginMarketplace: legacyPlugin,
        compatibility,
        previousReleaseId: null,
      },
      'r77',
    );
    const v5 = finalizeReleaseManifest(
      {
        ...common,
        schemaVersion: 5,
        pluginMarketplace,
        copilotPlugin,
        compatibility,
        previousReleaseId: null,
      },
      'r77',
    );
    const current = createCandidateManifest({
      gitSha: common.gitSha,
      createdAt: common.createdAt,
      previous: null,
      imageUpdates: digests,
      packages,
      pluginMarketplace,
      copilotPlugin,
      npmArtifactReportBytes,
    });
    const v6 = finalizeReleaseManifest(
      { ...current, schemaVersion: 6, images: legacyDigests },
      'r77',
    );
    expect([v4.manifestChecksum, v5.manifestChecksum, v6.manifestChecksum]).toEqual([
      'sha256:bfc96a5349e4c71759c62186887ef6fc1509e7fd9639fea83073e229ac30210a',
      'sha256:86a176a664b9f1a2e7b3978b8485e516544b1b7b4b47248946c8f5bf86daf992',
      'sha256:01ab683902a5b7fd787f39cd1f0e10e5008564a11b55127767181c4a278846c5',
    ]);
  });
});

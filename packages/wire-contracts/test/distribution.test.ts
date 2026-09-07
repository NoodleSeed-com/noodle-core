import { describe, expect, it } from 'vitest';
import {
  DISTRIBUTION_ARCHIVE_MAX_BYTES,
  DISTRIBUTION_GRANT_DEFAULT_TTL_SECONDS,
  DISTRIBUTION_GRANT_MAX_TTL_SECONDS,
  DistributionDownloadGrantRequestSchema,
  DistributionDownloadGrantResponseSchema,
  DistributionHumanReviewRequestSchema,
  DistributionLifecycleSchema,
  DistributionListResponseSchema,
  DistributionPublishRequestSchema,
  DistributionPublishResponseSchema,
  DistributionReadinessRequestSchema,
  DistributionReleaseRequestSchema,
  DistributionResponseSchema,
  PublicDistributionResponseSchema,
} from '../src/index.js';

const SHA = 'a'.repeat(64);

function publishRequest() {
  return {
    schemaVersion: 1,
    target: 'claude',
    variant: 'plugin',
    snapshotSha256: SHA,
    archive: {
      encoding: 'base64',
      content: 'UEsDBAoAAAAAAA==',
      byteLength: 10,
      sha256: 'b'.repeat(64),
      treeSha256: 'c'.repeat(64),
      adapterVersion: '1.0.0',
    },
  } as const;
}

function version() {
  return {
    id: 'dist_01J00000000000000000000000',
    schemaVersion: 1,
    orgSlug: 'acme',
    deploymentId: 'dep_123',
    appSlug: 'tasks',
    environment: 'prod',
    serverVersion: '2',
    target: 'claude',
    variant: 'plugin',
    version: 1,
    snapshotSha256: SHA,
    sourceManifestSha256: 'd'.repeat(64),
    mcpSurfaceSha256: 'e'.repeat(64),
    adapterVersion: '1.0.0',
    treeSha256: 'c'.repeat(64),
    archiveSha256: 'b'.repeat(64),
    byteLength: 10,
    createdAt: '2026-08-18T00:00:00.000Z',
    createdBySubject: 'principal_1',
    createdByEmail: 'builder@acme.test',
  } as const;
}

describe('hosted distribution wire contracts', () => {
  it('accepts only the target/variant pairs Noodle actually emits', () => {
    expect(DistributionPublishRequestSchema.safeParse(publishRequest()).success).toBe(true);
    expect(
      DistributionPublishRequestSchema.safeParse({
        ...publishRequest(),
        target: 'openai',
        variant: 'submission',
      }).success,
    ).toBe(true);
    expect(
      DistributionPublishRequestSchema.safeParse({
        ...publishRequest(),
        target: 'claude',
        variant: 'submission',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed base64, digest drift, oversize declarations, and unknown fields', () => {
    expect(
      DistributionPublishRequestSchema.safeParse({
        ...publishRequest(),
        archive: { ...publishRequest().archive, content: 'not base64' },
      }).success,
    ).toBe(false);
    expect(
      DistributionPublishRequestSchema.safeParse({
        ...publishRequest(),
        archive: { ...publishRequest().archive, sha256: 'nope' },
      }).success,
    ).toBe(false);
    expect(
      DistributionPublishRequestSchema.safeParse({
        ...publishRequest(),
        archive: {
          ...publishRequest().archive,
          byteLength: DISTRIBUTION_ARCHIVE_MAX_BYTES + 1,
        },
      }).success,
    ).toBe(false);
    expect(
      DistributionPublishRequestSchema.safeParse({ ...publishRequest(), unexpected: true }).success,
    ).toBe(false);
  });

  it('keeps publish, item, and list responses versioned while stripping additive fields', () => {
    expect(
      DistributionPublishResponseSchema.parse({
        ok: true,
        data: { ...version(), futureVersionField: true },
        replayed: false,
        futureEnvelopeField: true,
      }),
    ).toEqual({ ok: true, data: version(), replayed: false });
    expect(
      DistributionResponseSchema.parse({
        ok: true,
        data: { ...version(), futureVersionField: true },
        lifecycle: lifecycle(),
        futureEnvelopeField: true,
      }),
    ).toEqual({ ok: true, data: version(), lifecycle: lifecycle() });
    expect(
      DistributionListResponseSchema.parse({
        ok: true,
        data: {
          versions: [{ ...version(), futureVersionField: true }],
          futureDataField: true,
        },
        futureEnvelopeField: true,
      }),
    ).toEqual({ ok: true, data: { versions: [version()] } });
  });

  it('models internal readiness separately from explicitly human-reported host review evidence', () => {
    expect(
      DistributionReadinessRequestSchema.parse({ status: 'blocked', note: 'Fix the icon crop.' }),
    ).toEqual({ status: 'blocked', note: 'Fix the icon crop.' });
    expect(
      DistributionHumanReviewRequestSchema.parse({
        reportedStatus: 'changes-requested',
        feedback: 'Replace the first screenshot.',
      }),
    ).toEqual({
      reportedStatus: 'changes-requested',
      feedback: 'Replace the first screenshot.',
    });
    expect(
      DistributionHumanReviewRequestSchema.safeParse({
        reportedStatus: 'changes-requested',
      }).success,
    ).toBe(false);
    expect(
      DistributionLifecycleSchema.parse({ ...lifecycle(), futureLifecycleField: true }),
    ).toEqual(lifecycle());
  });

  it('keeps release visibility explicit and bounds short-lived private download grants', () => {
    expect(DistributionReleaseRequestSchema.parse({ visibility: 'public' })).toEqual({
      visibility: 'public',
    });
    expect(DistributionDownloadGrantRequestSchema.parse({})).toEqual({
      expiresInSeconds: DISTRIBUTION_GRANT_DEFAULT_TTL_SECONDS,
    });
    expect(
      DistributionDownloadGrantRequestSchema.safeParse({
        expiresInSeconds: DISTRIBUTION_GRANT_MAX_TTL_SECONDS + 1,
      }).success,
    ).toBe(false);
    expect(
      DistributionDownloadGrantResponseSchema.parse({
        ok: true,
        data: {
          grantId: 'dgrant_01J00000000000000000000000',
          distributionId: version().id,
          downloadPath:
            '/v1/distribution-download-grants/dgrant_01J00000000000000000000000/archive?token=secret',
          expiresAt: '2026-08-18T00:15:00.000Z',
        },
      }).data.downloadPath,
    ).not.toContain('acme');
  });

  it('exposes only safe active-release metadata through the anonymous discovery contract', () => {
    const parsed = PublicDistributionResponseSchema.parse({
      ok: true,
      data: {
        releaseId: 'drel_01J00000000000000000000000',
        appSlug: 'tasks',
        target: 'claude',
        variant: 'plugin',
        version: 2,
        archiveSha256: 'b'.repeat(64),
        byteLength: 10,
        archivePath: '/v1/distribution-releases/drel_01J00000000000000000000000/archive',
        orgSlug: 'must-be-stripped',
        deploymentId: 'must-be-stripped',
        createdByEmail: 'must-be-stripped@example.test',
      },
    });

    expect(parsed).toEqual({
      ok: true,
      data: {
        releaseId: 'drel_01J00000000000000000000000',
        appSlug: 'tasks',
        target: 'claude',
        variant: 'plugin',
        version: 2,
        archiveSha256: 'b'.repeat(64),
        byteLength: 10,
        archivePath: '/v1/distribution-releases/drel_01J00000000000000000000000/archive',
      },
    });
  });
});

function lifecycle() {
  return {
    schemaVersion: 1,
    distributionId: version().id,
    readiness: {
      status: 'ready',
      note: 'Package checks passed.',
      updatedAt: '2026-08-18T00:01:00.000Z',
      updatedBySubject: 'principal_1',
      updatedByEmail: 'builder@acme.test',
    },
    review: {
      source: 'human',
      reportedStatus: 'in-review',
      feedback: 'Submitted in the operator portal.',
      recordedAt: '2026-08-18T00:02:00.000Z',
      recordedBySubject: 'principal_1',
      recordedByEmail: 'builder@acme.test',
    },
    disposition: { status: 'available' },
    release: {
      id: 'drel_01J00000000000000000000000',
      activeDistributionId: version().id,
      visibility: 'private',
      updatedAt: '2026-08-18T00:03:00.000Z',
      updatedBySubject: 'principal_1',
      updatedByEmail: 'builder@acme.test',
    },
  } as const;
}

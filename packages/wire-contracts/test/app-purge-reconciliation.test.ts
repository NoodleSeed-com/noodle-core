import { describe, expect, it } from 'vitest';
import {
  AppPurgeReconciliationApplyRequestSchema,
  AppPurgeReconciliationApplyResponseSchema,
  AppPurgeReconciliationClientResponseSchema,
  AppPurgeReconciliationPreviewArtifactSchema,
  AppPurgeReconciliationPreviewRequestSchema,
  AppPurgeReconciliationPreviewResponseSchema,
  appPurgeReconciliationChecksumPayload,
} from '../src/index.js';

const APP_PURGE_RELEASE_SHA = 'a'.repeat(40);
const APP_PURGE_CHECKSUM = `sha256:${'b'.repeat(64)}`;
const APP_PURGE_CREATED_AT = '2026-09-02T10:00:00.000Z';
const APP_PURGE_EXPIRES_AT = '2026-09-02T10:15:00.000Z';
const APP_PURGE_AUDIT_ID = 'b5d1c18e-cc4e-4a3d-8fc2-60e5d5ea84d7';
const APP_PURGE_OPERATION_ID = '16e61afd-53a8-447f-8bae-4fc1c76bec4c';

const appPurgeCandidate = {
  org: 'acme',
  app: 'archive',
  anchorCreatedAt: APP_PURGE_CREATED_AT,
  purgeAuditId: APP_PURGE_AUDIT_ID,
  environments: [
    { name: 'development', isProduction: false, createdAt: APP_PURGE_CREATED_AT },
    { name: 'production', isProduction: true, createdAt: APP_PURGE_CREATED_AT },
  ],
} as const;

const appPurgeArtifact = {
  schemaVersion: 1,
  releaseSha: APP_PURGE_RELEASE_SHA,
  createdAt: APP_PURGE_CREATED_AT,
  expiresAt: APP_PURGE_EXPIRES_AT,
  candidateCount: 1,
  truncated: false,
  candidates: [appPurgeCandidate],
  checksum: APP_PURGE_CHECKSUM,
} as const;

const appPurgeApplyRequest = {
  schemaVersion: 1,
  preview: appPurgeArtifact,
  releaseSha: APP_PURGE_RELEASE_SHA,
  approvalReference: 'change-2026-09-02',
  recoveryCheckpoint: 'pitr-2026-09-02-0900',
  reason: 'repair stale app anchors after retention purge',
  idempotencyKey: 'app-purge-reconciliation-20260902',
  confirmed: true,
} as const;

describe('app purge reconciliation wire contract (ADR 0225)', () => {
  it('accepts complete zero and nonzero preview artifacts and a confirmed apply request', () => {
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidateCount: 0,
        candidates: [],
      }).success,
    ).toBe(true);
    expect(AppPurgeReconciliationPreviewArtifactSchema.safeParse(appPurgeArtifact).success).toBe(
      true,
    );
    expect(AppPurgeReconciliationApplyRequestSchema.safeParse(appPurgeApplyRequest).success).toBe(
      true,
    );
  });

  it('rejects malformed preview input before it can authorize deletion', () => {
    const secondCandidate = { ...appPurgeCandidate, app: 'zebra' };
    const duplicateEnvironment = {
      ...appPurgeCandidate,
      environments: [appPurgeCandidate.environments[0], appPurgeCandidate.environments[0]],
    };
    const unsortedEnvironment = {
      ...appPurgeCandidate,
      environments: [...appPurgeCandidate.environments].reverse(),
    };

    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidates: [{ ...appPurgeCandidate, unexpected: true }],
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidates: [secondCandidate, appPurgeCandidate],
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidateCount: 2,
        candidates: [appPurgeCandidate, appPurgeCandidate],
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidates: [duplicateEnvironment],
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidates: [unsortedEnvironment],
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidateCount: 2,
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        candidateCount: 0,
        candidates: [],
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewRequestSchema.safeParse({ schemaVersion: 1, limit: 101 })
        .success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        releaseSha: 'short',
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        checksum: 'sha256:INVALID',
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        expiresAt: '2026-09-02T10:16:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      AppPurgeReconciliationPreviewArtifactSchema.safeParse({
        ...appPurgeArtifact,
        expiresAt: '2026-09-02T09:59:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('requires complete evidence and an explicit apply confirmation', () => {
    const { approvalReference: _approvalReference, ...withoutApproval } = appPurgeApplyRequest;
    expect(AppPurgeReconciliationApplyRequestSchema.safeParse(withoutApproval).success).toBe(false);
    expect(
      AppPurgeReconciliationApplyRequestSchema.safeParse({
        ...appPurgeApplyRequest,
        confirmed: false,
      }).success,
    ).toBe(false);
  });

  it('keeps server output strict while client response readers strip additive fields', () => {
    const previewWithAdditions = {
      ok: true,
      artifact: {
        ...appPurgeArtifact,
        candidateCount: 1,
        serviceAddition: 'remove',
        candidates: [
          {
            ...appPurgeCandidate,
            candidateAddition: 'remove',
            environments: [
              {
                ...appPurgeCandidate.environments[0],
                environmentAddition: 'remove',
              },
              appPurgeCandidate.environments[1],
            ],
          },
        ],
      },
      envelopeAddition: 'remove',
    };
    const applyWithAdditions = {
      ok: true,
      replayed: false,
      result: {
        operationId: APP_PURGE_OPERATION_ID,
        previewChecksum: APP_PURGE_CHECKSUM,
        releaseSha: APP_PURGE_RELEASE_SHA,
        candidateCount: 1,
        deletedCount: 1,
        appliedAt: APP_PURGE_CREATED_AT,
        resultAddition: 'remove',
      },
      envelopeAddition: 'remove',
    };

    expect(
      AppPurgeReconciliationPreviewResponseSchema.safeParse(previewWithAdditions).success,
    ).toBe(false);
    expect(AppPurgeReconciliationApplyResponseSchema.safeParse(applyWithAdditions).success).toBe(
      false,
    );

    const preview = AppPurgeReconciliationClientResponseSchema.parse(previewWithAdditions);
    const apply = AppPurgeReconciliationClientResponseSchema.parse(applyWithAdditions);
    expect(preview).not.toHaveProperty('envelopeAddition');
    expect(preview).not.toHaveProperty('artifact.serviceAddition');
    expect(preview).not.toHaveProperty('artifact.candidates.0.candidateAddition');
    expect(preview).not.toHaveProperty('artifact.candidates.0.environments.0.environmentAddition');
    expect(apply).not.toHaveProperty('envelopeAddition');
    expect(apply).not.toHaveProperty('result.resultAddition');
  });

  it('serializes the checksum payload in canonical schema order', () => {
    const { checksum: _checksum, ...unsignedArtifact } = appPurgeArtifact;
    expect(appPurgeReconciliationChecksumPayload(unsignedArtifact)).toBe(
      JSON.stringify({
        schemaVersion: 1,
        releaseSha: APP_PURGE_RELEASE_SHA,
        createdAt: APP_PURGE_CREATED_AT,
        expiresAt: APP_PURGE_EXPIRES_AT,
        candidateCount: 1,
        truncated: false,
        candidates: [
          {
            org: 'acme',
            app: 'archive',
            anchorCreatedAt: APP_PURGE_CREATED_AT,
            purgeAuditId: APP_PURGE_AUDIT_ID,
            environments: [
              { name: 'development', isProduction: false, createdAt: APP_PURGE_CREATED_AT },
              { name: 'production', isProduction: true, createdAt: APP_PURGE_CREATED_AT },
            ],
          },
        ],
      }),
    );
  });
});

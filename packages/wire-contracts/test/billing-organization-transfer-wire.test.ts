import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BillingAdministrationOrganizationSearchRequestSchema,
  BillingAdministrationOrganizationsClientResponseSchema,
  BillingAdministrationOrganizationsResponseSchema,
  BillingAdministrationTransferApplyRequestSchema,
  BillingAdministrationTransferPreviewRequestSchema,
  BillingOrganizationTransferApplyClientResponseSchema,
  BillingOrganizationTransferApplyRequestSchema,
  BillingOrganizationTransferApplyResponseSchema,
  BillingOrganizationTransferArtifactSchema,
  BillingOrganizationTransferCandidatesClientResponseSchema,
  BillingOrganizationTransferCandidatesRequestSchema,
  BillingOrganizationTransferCandidatesResponseSchema,
  BillingOrganizationTransferPreviewClientResponseSchema,
  BillingOrganizationTransferPreviewRequestSchema,
  BillingOrganizationTransferPreviewResponseSchema,
  normalizeBillingOrganizationTransferServiceOrigin,
  WhoamiIdentityClientResponseSchema,
  WhoamiIdentityResponseSchema,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '..', '..', '..', 'contract', 'v1');
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(contractDir, name), 'utf8'));

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object fixture');
  }
  return value as Record<string, unknown>;
}

describe('billing organization transfer contracts', () => {
  const responseCases = [
    [
      'billing-org-transfer-candidates-response.json',
      BillingOrganizationTransferCandidatesResponseSchema,
      BillingOrganizationTransferCandidatesClientResponseSchema,
      [[], ['data'], ['data', 'items', 0], ['data', 'items', 0, 'organization']],
      (response: Record<string, unknown>) => delete mutableRecord(response.data).nextCursor,
    ],
    [
      'billing-org-transfer-preview-response.json',
      BillingOrganizationTransferPreviewResponseSchema,
      BillingOrganizationTransferPreviewClientResponseSchema,
      [
        [],
        ['data'],
        ['data', 'organization'],
        ['data', 'destination'],
        ['data', 'destination', 'plan'],
        ['data', 'currentPlan'],
        ['data', 'resultingPlan'],
        ['data', 'linkedOrganizationCounts'],
        ['data', 'productionCapacity'],
      ],
      (response: Record<string, unknown>) => delete mutableRecord(response.data).previewChecksum,
    ],
    [
      'billing-org-transfer-apply-response.json',
      BillingOrganizationTransferApplyResponseSchema,
      BillingOrganizationTransferApplyClientResponseSchema,
      [
        [],
        ['data'],
        ['data', 'organization'],
        ['data', 'destination'],
        ['data', 'destination', 'plan'],
        ['data', 'resultingPlan'],
        ['data', 'productionCapacity'],
      ],
      (response: Record<string, unknown>) => delete mutableRecord(response.data).operationId,
    ],
    [
      'billing-administration-organizations-response.json',
      BillingAdministrationOrganizationsResponseSchema,
      BillingAdministrationOrganizationsClientResponseSchema,
      [[], ['data'], ['data', 'items', 0], ['data', 'items', 0, 'organization']],
      (response: Record<string, unknown>) => delete mutableRecord(response.data).items,
    ],
    [
      'whoami-identity-response.json',
      WhoamiIdentityResponseSchema,
      WhoamiIdentityClientResponseSchema,
      [[], ['data'], ['data', 'identity']],
      (response: Record<string, unknown>) => delete mutableRecord(response.data).identity,
    ],
  ] as const;

  function addFutureField(
    response: Record<string, unknown>,
    path: readonly (string | number)[],
  ): void {
    let target: unknown = response;
    for (const segment of path) {
      target = Array.isArray(target) ? target[segment as number] : mutableRecord(target)[segment];
    }
    mutableRecord(target).futureField = true;
  }

  it.each(responseCases)('%s golden fixture parses as a strict server response', (name, strict) => {
    expect(strict.safeParse(fixture(name)).success).toBe(true);
  });

  it.each(
    responseCases,
  )('%s rejects additions at every server object layer', (name, strict, _client, paths) => {
    for (const path of paths) {
      const response = mutableRecord(structuredClone(fixture(name)));
      addFutureField(response, path);
      expect(strict.safeParse(response).success).toBe(false);
    }
  });

  it.each(
    responseCases,
  )('%s client reader accepts additions at every object layer', (name, _strict, client, paths) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    for (const path of paths) addFutureField(response, path);
    expect(client.safeParse(response).success).toBe(true);
  });

  it.each(
    responseCases,
  )('%s client reader requires every decision field', (name, _strict, client, _paths, remove) => {
    const response = mutableRecord(structuredClone(fixture(name)));
    remove(response);
    expect(client.safeParse(response).success).toBe(false);
  });

  it.each([
    BillingOrganizationTransferPreviewResponseSchema,
    BillingOrganizationTransferPreviewClientResponseSchema,
  ] as const)('rejects null preview plans when an unblocked preview is complete', (schema) => {
    for (const nullPlans of [
      { currentPlan: null },
      { resultingPlan: null },
      { currentPlan: null, resultingPlan: null },
    ]) {
      const response = mutableRecord(
        structuredClone(fixture('billing-org-transfer-preview-response.json')),
      );
      Object.assign(mutableRecord(response.data), nullPlans);
      expect(schema.safeParse(response).success).toBe(false);
    }
  });

  it.each([
    BillingOrganizationTransferPreviewResponseSchema,
    BillingOrganizationTransferPreviewClientResponseSchema,
  ] as const)('accepts null preview plans only for a blocked incomplete preview', (schema) => {
    const response = mutableRecord(
      structuredClone(fixture('billing-org-transfer-preview-response.json')),
    );
    Object.assign(mutableRecord(response.data), {
      currentPlan: null,
      resultingPlan: null,
      blockers: ['billing_setup_incomplete'],
    });
    expect(schema.safeParse(response).success).toBe(true);
  });

  it('keeps source billing-account identity and idempotency keys out of fixtures and public projections', () => {
    for (const [name, _strict, client] of responseCases) {
      const body = fixture(name);
      const parsed = client.parse(body);
      const rendered = JSON.stringify({ body, parsed }).toLowerCase();
      expect(rendered).not.toContain('sourcebillingaccount');
      expect(rendered).not.toContain('source_billing_account');
      expect(rendered).not.toContain('idempotencykey');
      expect(rendered).not.toContain('idempotency_key');
    }
  });

  const billingAccountId = 'ba_00000000-0000-0000-0000-000000000001';
  const checksum = 'a'.repeat(64);
  const ownerPreview = { schemaVersion: 1, destinationBillingAccountId: billingAccountId };
  const ownerApply = {
    ...ownerPreview,
    expectedLinkVersion: 1,
    previewChecksum: checksum,
    idempotencyKey: 'transfer-key',
    confirmed: true,
  } as const;
  const administratorPreview = {
    ...ownerPreview,
    organizationSlug: 'acme',
    administrativeReason: 'Support case 1234',
  } as const;
  const administratorApply = { ...administratorPreview, ...ownerApply } as const;

  it.each([
    [
      BillingOrganizationTransferCandidatesRequestSchema,
      { query: 'Acme', cursor: 'next', limit: 100 },
    ],
    [BillingOrganizationTransferPreviewRequestSchema, ownerPreview],
    [BillingOrganizationTransferApplyRequestSchema, ownerApply],
    [
      BillingAdministrationOrganizationSearchRequestSchema,
      { query: 'Acme', cursor: 'next', limit: 100 },
    ],
    [BillingAdministrationTransferPreviewRequestSchema, administratorPreview],
    [BillingAdministrationTransferApplyRequestSchema, administratorApply],
  ] as const)('accepts the exact strict request shape', (schema, request) => {
    expect(schema.safeParse(request).success).toBe(true);
    for (const forbidden of [
      'fallback',
      'authority',
      'sourceBillingAccountId',
      'actingAs',
      'actingAsSubject',
    ]) {
      expect(schema.safeParse({ ...request, [forbidden]: 'caller-supplied' }).success).toBe(false);
    }
  });

  it('enforces authority-specific request bounds without normalizing the idempotency key', () => {
    expect(BillingOrganizationTransferCandidatesRequestSchema.parse({})).toEqual({ limit: 50 });
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ query: 'x' }).success,
    ).toBe(true);
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ query: '' }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ query: 'x'.repeat(101) })
        .success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ cursor: 'x'.repeat(512) })
        .success,
    ).toBe(true);
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ cursor: 'x'.repeat(513) })
        .success,
    ).toBe(false);
    expect(BillingOrganizationTransferCandidatesRequestSchema.safeParse({ limit: 1 }).success).toBe(
      true,
    );
    expect(BillingOrganizationTransferCandidatesRequestSchema.safeParse({ limit: 0 }).success).toBe(
      false,
    );
    expect(
      BillingOrganizationTransferCandidatesRequestSchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
    expect(
      BillingAdministrationOrganizationSearchRequestSchema.safeParse({ query: 'x' }).success,
    ).toBe(false);
    expect(
      BillingAdministrationOrganizationSearchRequestSchema.safeParse({ query: 'x'.repeat(101) })
        .success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferPreviewRequestSchema.safeParse({
        ...ownerPreview,
        schemaVersion: 2,
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferPreviewRequestSchema.safeParse({
        ...ownerPreview,
        destinationBillingAccountId: 'account-1',
      }).success,
    ).toBe(false);
    expect(
      BillingAdministrationTransferPreviewRequestSchema.safeParse({
        ...administratorPreview,
        organizationSlug: 'Acme',
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        expectedLinkVersion: 0,
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        expectedLinkVersion: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        previewChecksum: checksum.toUpperCase(),
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        previewChecksum: 'a'.repeat(63),
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        idempotencyKey: 'x'.repeat(8),
      }).success,
    ).toBe(true);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        idempotencyKey: 'x'.repeat(256),
      }).success,
    ).toBe(true);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        idempotencyKey: 'x'.repeat(7),
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({
        ...ownerApply,
        idempotencyKey: 'x'.repeat(257),
      }).success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.safeParse({ ...ownerApply, confirmed: false })
        .success,
    ).toBe(false);
    expect(
      BillingOrganizationTransferApplyRequestSchema.parse({
        ...ownerApply,
        idempotencyKey: ' key-value ',
      }).idempotencyKey,
    ).toBe(' key-value ');
    expect(
      BillingAdministrationTransferPreviewRequestSchema.parse({
        ...administratorPreview,
        administrativeReason: '  Support case 1234  ',
      }).administrativeReason,
    ).toBe('Support case 1234');
    expect(
      BillingAdministrationTransferPreviewRequestSchema.safeParse({
        ...administratorPreview,
        administrativeReason: '   ',
      }).success,
    ).toBe(false);
    expect(
      BillingAdministrationTransferPreviewRequestSchema.safeParse({
        ...administratorPreview,
        administrativeReason: '\u0000',
      }).success,
    ).toBe(false);
    expect(
      BillingAdministrationTransferPreviewRequestSchema.safeParse({
        ...administratorPreview,
        administrativeReason: 'x'.repeat(257),
      }).success,
    ).toBe(false);
  });

  it('binds a reviewed transfer artifact to the exact organization and destination preview', () => {
    const previewResponse = mutableRecord(fixture('billing-org-transfer-preview-response.json'));
    const preview = mutableRecord(previewResponse.data);
    const artifact = {
      schemaVersion: 1,
      serviceOrigin: 'https://service.example',
      authorityPath: 'customer',
      request: {
        schemaVersion: 1,
        organizationSlug: mutableRecord(preview.organization).slug,
        destinationBillingAccountId: mutableRecord(preview.destination).id,
      },
      preview,
    } as const;

    expect(BillingOrganizationTransferArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(
      BillingOrganizationTransferArtifactSchema.safeParse({
        ...artifact,
        request: {
          ...artifact.request,
          destinationBillingAccountId: 'ba_00000000-0000-0000-0000-000000000002',
        },
      }).success,
    ).toBe(false);
  });

  it('normalizes only origin-shaped HTTP control-plane URLs', () => {
    expect(normalizeBillingOrganizationTransferServiceOrigin('https://service.example/')).toBe(
      'https://service.example',
    );
    expect(() =>
      normalizeBillingOrganizationTransferServiceOrigin('https://service.example/path'),
    ).toThrow('invalid service origin');
  });
});

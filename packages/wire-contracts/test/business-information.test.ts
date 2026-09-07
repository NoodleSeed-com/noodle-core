import { describe, expect, it } from 'vitest';
import {
  BusinessApiAdmissionErrorSchema,
  BusinessGrantResponseSchema,
  BusinessInvitationCreateRequestSchema,
  BusinessInvitationCreateResponseSchema,
  CollectionSourceConfigureRequestSchema,
  CollectionSourceRefreshRequestSchema,
  CollectionSourceRefreshResponseSchema,
  ExternalManagedRecordSchema,
  ManagedRecordMutationRequestSchema,
  ManagedRecordOperationNotSupportedErrorSchema,
  ManagedRecordResponseSchema,
  NativeManagedRecordSchema,
  SolutionCatalogResponseSchema,
  SolutionInstallationCapacityErrorSchema,
  SolutionInstallationCreateRequestSchema,
  SolutionInstallationIntakeRequestSchema,
  SolutionInstallationResponseSchema,
} from '../src/index.js';

const nativeCollection = {
  authority: 'native',
  key: 'travel_requests',
  title: 'Travel requests',
  singularTitle: 'Travel request',
  schemaVersion: 1,
  schemaDigest: 'a'.repeat(64),
  recordSchema: { type: 'object', properties: { destination: { type: 'string' } } },
  summaryFields: ['destination'],
  capabilities: {
    read: true,
    create: true,
    update: true,
    erase: true,
    sourceControls: false,
  },
};

const commonRecord = {
  id: 'rec_01jabc123',
  organizationId: 'acme',
  appSlug: 'travel-desk',
  environment: 'prod',
  installationId: 'ins_01jabc123',
  collection: 'travel_requests',
  schemaVersion: 1,
  schemaDigest: 'b'.repeat(64),
  payload: { destination: 'Edinburgh', travelers: 2 },
  revision: 1,
  createdAt: '2026-09-04T12:00:00.000Z',
  updatedAt: '2026-09-04T12:00:00.000Z',
  retentionExpiresAt: '2026-10-04T12:00:00.000Z',
};

describe('business-information wire contracts', () => {
  it('bounds admission diagnostics and keeps raw identities out of error projections', () => {
    const response = {
      code: 'business_api_rate_limited',
      error: 'Try again after the reset.',
      category: 'mutation',
      resetAt: '2026-09-07T10:21:00.000Z',
      limits: { subject: 1200, installation: 6000, org: 12000 },
    };
    expect(BusinessApiAdmissionErrorSchema.safeParse(response).success).toBe(true);
    expect(
      BusinessApiAdmissionErrorSchema.safeParse({ ...response, subject: 'private-person' }).success,
    ).toBe(false);
    expect(
      BusinessApiAdmissionErrorSchema.safeParse({
        ...response,
        limits: { ...response.limits, org: -1 },
      }).success,
    ).toBe(false);
    expect(
      BusinessApiAdmissionErrorSchema.safeParse({
        code: 'business_api_admission_unavailable',
        error: 'Retry later.',
      }).success,
    ).toBe(true);
    expect(
      SolutionInstallationCapacityErrorSchema.safeParse({
        code: 'installation_capacity_exceeded',
        error: 'Reuse an existing installation.',
      }).success,
    ).toBe(true);
  });

  it('projects independent native controls and assignment without the historical request bundle', () => {
    expect(
      SolutionCatalogResponseSchema.safeParse({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Travel operations.',
              collections: [
                {
                  ...nativeCollection,
                  management: { notes: true },
                  fields: { destination: { label: 'Destination' } },
                  publicFields: ['destination'],
                  editableFields: ['destination'],
                  filterFields: ['destination'],
                  sortFields: ['destination'],
                },
              ],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      NativeManagedRecordSchema.safeParse({
        ...commonRecord,
        authority: 'native',
        origin: { surface: 'portal' },
        assigneeSubject: 'operator',
      }).success,
    ).toBe(true);
  });

  it('publishes exactly three managed vertical profiles with authority-aware collections', () => {
    expect(
      SolutionCatalogResponseSchema.safeParse({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Receive and operate travel requests.',
              collections: [nativeCollection],
            },
          ],
        },
      }).success,
    ).toBe(true);
    for (const retiredCatalogId of ['b2b_saas', 'unknown']) {
      expect(
        SolutionCatalogResponseSchema.safeParse({
          ok: true,
          data: {
            profiles: [
              {
                id: retiredCatalogId,
                title: 'Not managed',
                description: 'Not a managed solution.',
                collections: [nativeCollection],
              },
            ],
          },
        }).success,
      ).toBe(false);
    }
  });

  it('strictly discriminates native and external collection projections', () => {
    const external = {
      ...nativeCollection,
      authority: 'external',
      capabilities: {
        read: true,
        create: false,
        update: false,
        erase: true,
        sourceControls: true,
      },
      source: {
        connector: 'calendar',
        scanOperation: 'scan_events',
      },
    };
    expect(
      SolutionCatalogResponseSchema.safeParse({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Receive and operate travel requests.',
              collections: [external],
            },
          ],
        },
      }).success,
    ).toBe(true);
    expect(
      SolutionCatalogResponseSchema.safeParse({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Receive and operate travel requests.',
              collections: [{ ...external, capabilities: nativeCollection.capabilities }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('accepts either a managed profile selector or an immutable private definition reference', () => {
    const settings = { appSlug: 'travel-desk', environment: 'prod', retentionDays: 30 };
    expect(
      SolutionInstallationCreateRequestSchema.parse({
        definition: { kind: 'managed', profileId: 'travel' },
        ...settings,
      }),
    ).toEqual({
      definition: { kind: 'managed', profileId: 'travel' },
      ...settings,
    });
    expect(
      SolutionInstallationCreateRequestSchema.safeParse({
        definition: {
          kind: 'private',
          publisherOrg: 'publisher',
          app: 'customer-ops',
          environment: 'prod',
          deploymentId: 'dep_123',
        },
        ...settings,
      }).success,
    ).toBe(true);
    expect(
      SolutionInstallationCreateRequestSchema.safeParse({
        definition: { kind: 'managed', profileId: 'b2b_saas' },
        ...settings,
      }).success,
    ).toBe(false);
    expect(
      SolutionInstallationCreateRequestSchema.safeParse({
        definition: { kind: 'private', publisherOrg: 'publisher' },
        ...settings,
      }).success,
    ).toBe(false);
  });

  it('requires a strict intake state and installation revision', () => {
    expect(
      SolutionInstallationIntakeRequestSchema.parse({ active: false, expectedRevision: 3 }),
    ).toEqual({ active: false, expectedRevision: 3 });
    expect(
      SolutionInstallationIntakeRequestSchema.safeParse({
        active: false,
        expectedRevision: 0,
      }).success,
    ).toBe(false);
    expect(
      SolutionInstallationIntakeRequestSchema.safeParse({
        active: true,
        expectedRevision: 3,
        guessed: true,
      }).success,
    ).toBe(false);
  });

  it('projects a private application with no collections and keeps the sixteen-collection bound', () => {
    const response = {
      ok: true,
      data: {
        installation: {
          id: 'ins_tools',
          organizationId: 'acme',
          appSlug: 'calendar',
          environment: 'prod',
          retentionDays: 30,
          publicId: 'public_123',
          active: true,
          currentRole: 'viewer',
          revision: 1,
          definition: {
            kind: 'private',
            publisherOrg: 'acme',
            app: 'calendar',
            environment: 'prod',
            deploymentId: 'dep_123',
            version: '1.0.0',
            digest: 'c'.repeat(64),
          },
          collections: [],
          createdAt: commonRecord.createdAt,
          updatedAt: commonRecord.updatedAt,
          createdBySubject: 'owner',
        },
      },
    };
    expect(SolutionInstallationResponseSchema.safeParse(response).success).toBe(true);
    const withCount = (count: number) => ({
      ...response,
      data: {
        installation: {
          ...response.data.installation,
          collections: Array.from({ length: count }, (_, index) => ({
            ...nativeCollection,
            key: `items_${index}`,
          })),
        },
      },
    });
    expect(SolutionInstallationResponseSchema.safeParse(withCount(16)).success).toBe(true);
    expect(SolutionInstallationResponseSchema.safeParse(withCount(17)).success).toBe(false);
  });

  it('retains a strict reader for a legacy b2b_saas installation', () => {
    expect(
      SolutionInstallationResponseSchema.safeParse({
        ok: true,
        data: {
          installation: {
            id: 'ins_legacy',
            organizationId: 'acme',
            profileId: 'b2b_saas',
            appSlug: 'support-desk',
            environment: 'prod',
            retentionDays: 30,
            publicId: 'public_123',
            active: true,
            currentRole: 'viewer',
            revision: 1,
            definition: {
              kind: 'legacy',
              definitionId: 'b2b_saas',
              release: 1,
              digest: 'c'.repeat(64),
            },
            collections: [{ ...nativeCollection, key: 'service_requests' }],
            createdAt: '2026-09-04T12:00:00.000Z',
            updatedAt: '2026-09-04T12:00:00.000Z',
            createdBySubject: 'owner_123',
          },
        },
      }).success,
    ).toBe(true);
  });

  it('keeps business grants installation-scoped and role-bounded', () => {
    expect(
      BusinessGrantResponseSchema.safeParse({
        ok: true,
        data: {
          grant: {
            installationId: 'ins_01jabc123',
            subject: 'user_123',
            email: 'operator@example.com',
            role: 'operator',
            revision: 1,
            createdAt: '2026-09-04T12:00:00.000Z',
            createdBySubject: 'owner_123',
          },
        },
      }).success,
    ).toBe(true);
    expect(
      BusinessGrantResponseSchema.safeParse({
        ok: true,
        data: {
          grant: {
            installationId: 'ins_01jabc123',
            subject: 'user_123',
            email: 'operator@example.com',
            role: 'developer',
            revision: 1,
            createdAt: '2026-09-04T12:00:00.000Z',
            createdBySubject: 'owner_123',
          },
        },
      }).success,
    ).toBe(false);
  });

  it('bounds staff invitation secrets, expiry, and browser acceptance paths', () => {
    const token = 'a'.repeat(43);
    expect(
      BusinessInvitationCreateRequestSchema.safeParse({
        email: 'operator@example.com',
        role: 'operator',
        token,
        idempotencyKey: 'invite-1',
      }).success,
    ).toBe(true);
    expect(
      BusinessInvitationCreateRequestSchema.safeParse({
        email: 'operator@example.com',
        role: 'operator',
        token: 'too-short',
        idempotencyKey: 'invite-1',
      }).success,
    ).toBe(false);
    expect(
      BusinessInvitationCreateResponseSchema.safeParse({
        ok: true,
        data: {
          invitation: {
            invitationId: 'binv_1',
            installationId: 'ins_1',
            email: 'operator@example.com',
            role: 'operator',
            status: 'pending',
            revision: 1,
            createdAt: '2026-09-05T12:00:00.000Z',
            expiresAt: '2026-09-12T12:00:00.000Z',
            createdBySubject: 'owner_1',
          },
          acceptPath: `/portal-invitations/${token}`,
          replayed: false,
        },
      }).success,
    ).toBe(true);
  });

  it('separates native request behavior from the common record envelope', () => {
    const record = {
      ...commonRecord,
      authority: 'native',
      origin: { surface: 'public' },
      request: { status: 'new' },
    };
    expect(NativeManagedRecordSchema.safeParse(record).success).toBe(true);
    expect(ManagedRecordResponseSchema.safeParse({ ok: true, data: { record } }).success).toBe(
      true,
    );
    expect(
      ManagedRecordResponseSchema.safeParse({
        ok: true,
        data: { record, collection: { ...nativeCollection, schemaDigest: record.schemaDigest } },
      }).success,
    ).toBe(true);
    expect(
      NativeManagedRecordSchema.safeParse({ ...record, status: 'new', request: undefined }).success,
    ).toBe(false);
  });

  it('requires immutable source provenance on external record projections', () => {
    const record = {
      ...commonRecord,
      authority: 'external',
      source: {
        bindingReference: 'binding_123',
        bindingGeneration: 2,
        sourceRecordId: 'external_456',
        sourceVersion: 'etag-7',
        observedAt: '2026-09-04T12:00:00.000Z',
        lastCompletedSyncAt: '2026-09-04T11:59:00.000Z',
        health: 'healthy',
        completeness: 'complete',
      },
    };
    expect(ExternalManagedRecordSchema.safeParse(record).success).toBe(true);
    expect(
      ExternalManagedRecordSchema.safeParse({
        ...record,
        source: { ...record.source, bindingGeneration: undefined },
      }).success,
    ).toBe(false);
    expect(
      ExternalManagedRecordSchema.safeParse({ ...record, status: 'in_progress' }).success,
    ).toBe(false);
  });

  it('accepts explicit optimistic native operations and rejects ambiguous patches', () => {
    for (const mutation of [
      { operation: 'update', expectedRevision: 2, patch: { destination: 'EDI' } },
      { operation: 'update', expectedRevision: 2, patch: {}, unset: ['reference'] },
      { operation: 'assign', expectedRevision: 2, assigneeSubject: 'operator_1' },
      { operation: 'set-status', expectedRevision: 2, status: 'in_progress' },
      { operation: 'add-note', expectedRevision: 2, note: 'Called the traveler.' },
    ]) {
      expect(ManagedRecordMutationRequestSchema.safeParse(mutation).success).toBe(true);
    }
    expect(
      ManagedRecordMutationRequestSchema.safeParse({
        operation: 'update',
        expectedRevision: 2,
        patch: { destination: 'EDI' },
        status: 'resolved',
      }).success,
    ).toBe(false);
  });

  it('bounds explicit removal keys and rejects invalid shapes before record lookup', () => {
    for (const unset of [
      null,
      'reference',
      [''],
      ['reference', 'reference'],
      ['x'.repeat(65)],
      Array.from({ length: 129 }, (_, i) => `field_${i}`),
    ]) {
      expect(
        ManagedRecordMutationRequestSchema.safeParse({
          operation: 'update',
          expectedRevision: 2,
          patch: {},
          unset,
        }).success,
      ).toBe(false);
    }
  });

  it('types the external-record mutation rejection', () => {
    expect(
      ManagedRecordOperationNotSupportedErrorSchema.safeParse({
        ok: false,
        error: 'external collection records cannot be updated through the record API',
        code: 'operation_not_supported',
        details: { authority: 'external', operation: 'update' },
      }).success,
    ).toBe(true);
  });

  it('requires source consent and retry-safe refresh input', () => {
    expect(
      CollectionSourceConfigureRequestSchema.safeParse({
        expectedRevision: 2,
        binding: { reference: 'binding_123', generation: 3 },
        configurationReference: 'config_456',
        enable: true,
      }).success,
    ).toBe(true);
    expect(
      CollectionSourceConfigureRequestSchema.safeParse({
        expectedRevision: 3,
        binding: { reference: 'binding_123', generation: 4 },
        configurationReference: 'config_789',
        enable: true,
        replace: true,
      }).success,
    ).toBe(true);
    expect(
      CollectionSourceConfigureRequestSchema.safeParse({
        expectedRevision: 3,
        binding: { reference: 'binding_123', generation: 4 },
        configurationReference: 'config_789',
        enable: true,
        replace: false,
      }).success,
    ).toBe(false);
    expect(
      CollectionSourceConfigureRequestSchema.safeParse({
        expectedRevision: 2,
        binding: { reference: 'binding_123', generation: 3 },
        configurationReference: 'config_456',
      }).success,
    ).toBe(false);
    const terminalJob = {
      id: 'refresh_job_1',
      state: 'superseded',
      coalesced: false,
      requestedAt: '2026-09-07T00:00:00.000Z',
      replayExpiresAt: '2026-10-07T00:00:00.000Z',
    };
    const jobSchema = CollectionSourceRefreshResponseSchema.shape.data.shape.job;
    expect(jobSchema.safeParse(terminalJob).success).toBe(true);
    expect(jobSchema.safeParse({ ...terminalJob, state: 'complete' }).success).toBe(false);
    expect(jobSchema.safeParse({ ...terminalJob, rawIdempotencyKey: 'private' }).success).toBe(
      false,
    );
    expect(
      CollectionSourceRefreshRequestSchema.safeParse({
        expectedRevision: 2,
        idempotencyKey: 'refresh-2026-09-05',
      }).success,
    ).toBe(true);
  });
});

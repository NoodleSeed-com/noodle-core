import { describe, expect, it } from 'vitest';
import {
  BusinessGrantResponseSchema,
  ManagedRecordMutationRequestSchema,
  ManagedRecordResponseSchema,
  SolutionCatalogResponseSchema,
  SolutionInstallationCreateRequestSchema,
  SolutionInstallationResponseSchema,
} from '../src/index.js';

describe('business-information wire contracts', () => {
  it('accepts a bounded built-in solution catalog entry', () => {
    expect(
      SolutionCatalogResponseSchema.safeParse({
        ok: true,
        data: {
          profiles: [
            {
              id: 'travel',
              title: 'Travel',
              description: 'Receive and operate travel requests.',
              collection: {
                key: 'travel_requests',
                title: 'Travel requests',
                singularTitle: 'Travel request',
                schemaVersion: 1,
                schemaDigest: 'a'.repeat(64),
                recordSchema: { type: 'object', properties: { destination: { type: 'string' } } },
                summaryFields: ['destination'],
              },
            },
          ],
        },
      }).success,
    ).toBe(true);
  });

  it('accepts an installation request with an approved retention period', () => {
    expect(
      SolutionInstallationCreateRequestSchema.parse({
        profileId: 'travel',
        appSlug: 'travel-desk',
        environment: 'prod',
        retentionDays: 30,
      }),
    ).toEqual({
      profileId: 'travel',
      appSlug: 'travel-desk',
      environment: 'prod',
      retentionDays: 30,
    });
    expect(
      SolutionInstallationCreateRequestSchema.safeParse({
        profileId: 'travel',
        appSlug: 'travel-desk',
        environment: 'prod',
        retentionDays: 365,
      }).success,
    ).toBe(false);
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

  it('includes the caller business role in an installation response', () => {
    expect(
      SolutionInstallationResponseSchema.safeParse({
        ok: true,
        data: {
          installation: {
            id: 'ins_01jabc123',
            organizationId: 'acme',
            profileId: 'travel',
            appSlug: 'travel-desk',
            environment: 'prod',
            retentionDays: 30,
            publicId: 'public_123',
            active: true,
            currentRole: 'viewer',
            revision: 1,
            collection: {
              key: 'travel_requests',
              title: 'Travel requests',
              singularTitle: 'Travel request',
              schemaVersion: 1,
              schemaDigest: 'a'.repeat(64),
              recordSchema: { type: 'object' },
              summaryFields: ['summary'],
            },
            createdAt: '2026-09-04T12:00:00.000Z',
            updatedAt: '2026-09-04T12:00:00.000Z',
            createdBySubject: 'owner_123',
          },
        },
      }).success,
    ).toBe(true);
  });

  it('accepts explicit optimistic record operations and rejects ambiguous patches', () => {
    for (const mutation of [
      { operation: 'update', expectedRevision: 2, patch: { destination: 'EDI' } },
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

  it('pins the current managed-record response without exposing internal ciphertext', () => {
    const response = {
      ok: true,
      data: {
        record: {
          id: 'rec_01jabc123',
          installationId: 'ins_01jabc123',
          collection: 'travel_requests',
          schemaVersion: 1,
          schemaDigest: 'b'.repeat(64),
          payload: { destination: 'Edinburgh', travelers: 2 },
          status: 'new',
          revision: 1,
          origin: { surface: 'public' },
          createdAt: '2026-09-04T12:00:00.000Z',
          updatedAt: '2026-09-04T12:00:00.000Z',
          retentionExpiresAt: '2026-10-04T12:00:00.000Z',
        },
      },
    };
    expect(ManagedRecordResponseSchema.safeParse(response).success).toBe(true);
    expect(
      ManagedRecordResponseSchema.safeParse({
        ...response,
        data: { record: { ...response.data.record, ciphertext: 'secret' } },
      }).success,
    ).toBe(false);
  });
});

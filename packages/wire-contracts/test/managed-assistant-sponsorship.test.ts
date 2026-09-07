import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ManagedAssistantSponsorshipClientResponseSchema,
  ManagedAssistantSponsorshipGrantCreateRequestSchema,
  ManagedAssistantSponsorshipResponseSchema,
} from '../src/index.js';

const contractDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'contract',
  'v1',
);

function mutableRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected an object fixture');
  }
  return value as Record<string, unknown>;
}

describe('managed assistant sponsorship contracts', () => {
  it('pins a strict service response and an additive client reader', () => {
    const response = mutableRecord(
      JSON.parse(
        readFileSync(join(contractDir, 'managed-assistant-sponsorship-response.json'), 'utf8'),
      ),
    );
    expect(ManagedAssistantSponsorshipResponseSchema.safeParse(response).success).toBe(true);
    expect(
      ManagedAssistantSponsorshipResponseSchema.safeParse({ ...response, futureEnvelope: true })
        .success,
    ).toBe(false);
    const data = mutableRecord(response.data);
    data.futureData = true;
    mutableRecord(data.spend).futureSpend = true;
    const grants = Array.isArray(data.grants) ? data.grants.map(mutableRecord) : [];
    const [grant] = grants;
    if (grant === undefined) throw new Error('managed sponsorship fixture must contain a grant');
    grant.futureGrant = true;
    expect(ManagedAssistantSponsorshipClientResponseSchema.safeParse(response).success).toBe(true);
  });

  it('requires bounded expiring grants with attributable idempotency', () => {
    expect(
      ManagedAssistantSponsorshipGrantCreateRequestSchema.safeParse({
        additionalTurnsPerDay: 500,
        expiresAt: '2026-09-30T00:00:00.000Z',
        reason: 'Design partner sponsored beta',
        idempotencyKey: 'partner-acme-2026-08',
      }).success,
    ).toBe(true);
    expect(
      ManagedAssistantSponsorshipGrantCreateRequestSchema.safeParse({
        additionalTurnsPerDay: 0,
        expiresAt: '2026-09-30T00:00:00.000Z',
        reason: 'No bound',
        idempotencyKey: 'partner-acme-2026-08',
      }).success,
    ).toBe(false);
  });
});

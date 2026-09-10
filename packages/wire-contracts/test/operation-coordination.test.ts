import { describe, expect, it } from 'vitest';
import {
  OperationCoordinationListClientResponseSchema,
  OperationCoordinationListResponseSchema,
  OperationCoordinationResolveRequestSchema,
} from '../src/operation-coordination.js';

const resource = 'a'.repeat(64);
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
describe('operation coordination wire boundaries', () => {
  it('allows only deliberate bounded reviews without caller-supplied authority', () => {
    const valid = { resource, token, reason: 'Reviewed the external system' };
    expect(OperationCoordinationResolveRequestSchema.parse(valid)).toEqual(valid);
    for (const input of [
      { ...valid, reviewer: 'forged' },
      { ...valid, scope: { org: 'other' } },
      { ...valid, reason: 'a'.repeat(257) },
      { ...valid, reason: ' ' },
      { ...valid, reason: 'text\u001bescape' },
      { ...valid, reason: 'text\u2028separator' },
      { ...valid, token: 'invalid' },
      { ...valid, resource: 'invalid' },
    ])
      expect(OperationCoordinationResolveRequestSchema.safeParse(input).success).toBe(false);
  });
  it('keeps server output strict while clients discard unknown nested fields', () => {
    const record = {
      resource,
      token,
      reference: 'external-id',
      operationDigest: resource,
      state: 'unknown',
      startedAt: '2026-09-10T00:00:00.000Z',
      deadline: '2026-09-10T00:01:00.000Z',
    };
    const response = {
      ok: true,
      extra: 'hidden',
      data: { extra: 'hidden', records: [{ ...record, extra: 'hidden' }] },
    };
    expect(OperationCoordinationListResponseSchema.safeParse(response).success).toBe(false);
    expect(OperationCoordinationListClientResponseSchema.parse(response)).toEqual({
      ok: true,
      data: { records: [record] },
    });
  });
});

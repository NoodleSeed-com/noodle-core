import { expect, it } from 'vitest';
import {
  BusinessWorkspaceAcceptRequestSchema,
  BusinessWorkspaceClientResponseSchema,
  BusinessWorkspaceInvitationRequestSchema,
  BusinessWorkspaceListClientResponseSchema,
  BusinessWorkspaceListQuerySchema,
  BusinessWorkspaceListResponseSchema,
  BusinessWorkspaceResponseSchema,
} from '../src/business-workspaces.js';

const now = '2026-09-19T00:00:00.000Z';
const state = {
  org: 'acme',
  authorityVersion: 1,
  revision: 1,
  activatedAt: now,
  role: 'owner',
  permissions: ['team:manage'],
  members: [{ subject: 'owner', role: 'owner', joinedAt: now }],
  invitations: [],
};
it('bounds discovery queries and strips additive metadata without accepting malformed memberships', () => {
  expect(BusinessWorkspaceListQuerySchema.parse({})).toEqual({ limit: 50 });
  for (const query of [{ limit: 101 }, { limit: 0 }, { subject: 'owner' }, { cursor: '' }])
    expect(BusinessWorkspaceListQuerySchema.safeParse(query).success).toBe(false);
  const membership = {
    org: 'acme',
    authorityVersion: 1,
    revision: 1,
    role: 'owner',
    permissions: ['team:manage'],
  };
  const response = {
    ok: true,
    data: { workspaces: [{ ...membership, future: true }], nextCursor: 'YWNtZQ', future: true },
    future: true,
  };
  expect(BusinessWorkspaceListResponseSchema.safeParse(response).success).toBe(false);
  expect(BusinessWorkspaceListClientResponseSchema.parse(response)).toEqual({
    ok: true,
    data: { workspaces: [membership], nextCursor: 'YWNtZQ' },
  });
  expect(
    BusinessWorkspaceListClientResponseSchema.safeParse({
      ok: true,
      data: { workspaces: [{ ...membership, role: 'manager' }] },
    }).success,
  ).toBe(false);
});
it('uses strict authoritative schemas and strips additive client fields at every object layer', () => {
  const response = {
    ok: true,
    data: { ...state, future: true, members: [{ ...state.members[0], future: true }] },
    future: true,
  };
  expect(BusinessWorkspaceResponseSchema.safeParse(response).success).toBe(false);
  expect(BusinessWorkspaceClientResponseSchema.parse(response)).toEqual({ ok: true, data: state });
});
it('defaults invitation role without allowing caller-authored authority or identity', () => {
  expect(
    BusinessWorkspaceInvitationRequestSchema.parse({
      email: 'staff@example.test',
      expectedRevision: 1,
    }).role,
  ).toBe('operator');
  expect(
    BusinessWorkspaceInvitationRequestSchema.safeParse({
      email: 'staff@example.test',
      expectedRevision: 1,
      role: 'manager',
    }).success,
  ).toBe(false);
  expect(
    BusinessWorkspaceAcceptRequestSchema.safeParse({
      token: 'i'.repeat(43),
      verifiedEmail: 'owner@example.test',
    }).success,
  ).toBe(false);
});

import { expect, it } from 'vitest';
import {
  BusinessInstallationAccessSchema,
  EligibleBusinessAssigneeListClientResponseSchema,
  EligibleBusinessAssigneeListResponseSchema,
} from '../src/business-information.js';

it('keeps fixed workspace roles distinct from legacy installation roles', () => {
  for (const currentRole of ['owner', 'administrator', 'builder', 'operator', 'viewer'])
    expect(
      BusinessInstallationAccessSchema.safeParse({ currentRole, authorityVersion: 1 }).success,
    ).toBe(true);
  for (const currentRole of ['administrator', 'manager', 'operator', 'viewer'])
    expect(BusinessInstallationAccessSchema.safeParse({ currentRole }).success).toBe(true);
  for (const input of [
    { currentRole: 'owner' },
    { currentRole: 'builder' },
    { currentRole: 'manager', authorityVersion: 1 },
    { currentRole: 'administrator', authorityVersion: 2 },
  ])
    expect(BusinessInstallationAccessSchema.safeParse(input).success).toBe(false);
});

it('projects minimal assignment choices with additive client reads, never an authority downgrade', () => {
  const assignee = { subject: 'owner', role: 'owner', authorityVersion: 1 };
  const response = { ok: true, data: { assignees: [assignee] } };
  expect(EligibleBusinessAssigneeListResponseSchema.parse(response)).toEqual(response);
  expect(
    EligibleBusinessAssigneeListClientResponseSchema.parse({
      ...response,
      future: true,
      data: { future: true, assignees: [{ ...assignee, future: true }] },
    }),
  ).toEqual(response);
  for (const invalid of [
    { ...assignee, role: 'builder' },
    { ...assignee, role: 'viewer' },
    { ...assignee, role: 'manager', email: 'person@example.test' },
    { ...assignee, authorityVersion: 2, role: 'operator', email: 'person@example.test' },
  ]) {
    const body = { ok: true, data: { assignees: [invalid] } };
    expect(EligibleBusinessAssigneeListResponseSchema.safeParse(body).success).toBe(false);
    expect(EligibleBusinessAssigneeListClientResponseSchema.safeParse(body).success).toBe(false);
  }
});

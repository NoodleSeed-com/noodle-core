import { z } from 'zod';

/** Versioned workspace roles are distinct from legacy installation grants. */
export const BusinessWorkspaceRoleSchema = z.enum([
  'owner',
  'administrator',
  'builder',
  'operator',
  'viewer',
]);
export type BusinessWorkspaceRole = z.infer<typeof BusinessWorkspaceRoleSchema>;

export const BusinessWorkspaceInvitationRequestSchema = z.strictObject({
  email: z.email().max(254),
  role: BusinessWorkspaceRoleSchema.default('operator'),
  expectedRevision: z.number().int().positive().max(2147483647),
});

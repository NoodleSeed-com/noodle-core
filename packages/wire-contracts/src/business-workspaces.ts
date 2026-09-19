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

export const BusinessWorkspacePermissionSchema = z.enum([
  'records:read',
  'records:write',
  'records:export',
  'records:erase',
  'drafts:read',
  'drafts:edit',
  'drafts:preview',
  'applications:publish',
  'settings:manage',
  'team:manage',
  'owners:manage',
  'billing:manage',
  'workspace:delete',
]);
const revision = z.number().int().positive().max(2147483647);
const subject = z.string().min(1).max(500);
const member = z.strictObject({
  subject,
  role: BusinessWorkspaceRoleSchema,
  joinedAt: z.iso.datetime(),
});
const invitation = z.strictObject({
  id: z.uuid(),
  email: z.email().max(254),
  role: BusinessWorkspaceRoleSchema,
  createdBy: subject,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
const projection = z.strictObject({
  org: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  authorityVersion: z.literal(1),
  revision,
  activatedAt: z.iso.datetime(),
  role: BusinessWorkspaceRoleSchema,
  permissions: z.array(BusinessWorkspacePermissionSchema).max(13),
  members: z.array(member).min(1).max(1000),
  invitations: z.array(invitation).max(100),
});
export const BusinessWorkspaceResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: projection,
});
export const BusinessWorkspaceClientResponseSchema = z.object({
  ok: z.literal(true),
  data: projection
    .extend({
      members: z.array(member.strip()).min(1).max(1000),
      invitations: z.array(invitation.strip()).max(100),
    })
    .strip(),
});
export const BusinessWorkspaceRoleChangeRequestSchema = z.strictObject({
  expectedRevision: revision,
  subject,
  role: BusinessWorkspaceRoleSchema.nullable(),
});
export const BusinessWorkspaceRevisionRequestSchema = z.strictObject({
  expectedRevision: revision,
});
export const BusinessWorkspaceAcceptRequestSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
const issued = z.strictObject({
  id: z.uuid(),
  role: BusinessWorkspaceRoleSchema,
  token: BusinessWorkspaceAcceptRequestSchema.shape.token,
  expiresAt: z.iso.datetime(),
  revision,
});
export const BusinessWorkspaceIssuedInvitationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: issued,
});
export const BusinessWorkspaceIssuedInvitationClientResponseSchema = z.object({
  ok: z.literal(true),
  data: issued.strip(),
});
export const BusinessWorkspaceMutationResponseSchema = z.strictObject({
  ok: z.literal(true),
  data: z.strictObject({ revision }),
});
export const BusinessWorkspaceMutationClientResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ revision }),
});

export const BusinessWorkspaceInvitationRequestSchema = z.strictObject({
  email: z.email().max(254),
  role: BusinessWorkspaceRoleSchema.default('operator'),
  expectedRevision: revision,
});

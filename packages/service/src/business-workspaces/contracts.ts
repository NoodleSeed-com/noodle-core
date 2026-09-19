import { SLUG_PATTERN, validateSlug } from '@noodle-borg/control-plane/portable';
import { BusinessWorkspaceRoleSchema } from '@noodle-borg/wire-contracts';
import { z } from 'zod';

export const WorkspaceSubjectSchema = z.string().min(1).max(500);
export const WorkspaceOrgSchema = z
  .string()
  .regex(SLUG_PATTERN)
  .refine((value) => {
    try {
      validateSlug('org', value);
      return true;
    } catch {
      return false;
    }
  });
export const WorkspaceRevisionSchema = z.number().int().positive().max(2147483647);
export const WorkspaceMemberSchema = z.strictObject({
  subject: WorkspaceSubjectSchema,
  role: BusinessWorkspaceRoleSchema,
  joinedAt: z.iso.datetime(),
});
const invitation = z.strictObject({
  id: z.string().uuid(),
  email: z.email().max(254),
  role: BusinessWorkspaceRoleSchema,
  tokenDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdBy: WorkspaceSubjectSchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
/** Internal encrypted state. Never serialize pending invitation material into a staff response. */
export const WorkspaceStateSchema = z.strictObject({
  org: WorkspaceOrgSchema,
  authorityVersion: z.literal(1),
  revision: WorkspaceRevisionSchema,
  initializedBy: WorkspaceSubjectSchema,
  activatedAt: z.iso.datetime(),
  members: z.array(WorkspaceMemberSchema).min(1).max(1000),
  invitations: z.array(invitation).max(100),
});
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;
export type WorkspaceInvitation = z.infer<typeof invitation>;
export interface WorkspaceAuditEvent {
  readonly revision: number;
  readonly actor: string;
  readonly action:
    | 'initialized'
    | 'invited'
    | 'accepted'
    | 'role_changed'
    | 'removed'
    | 'invitation_revoked';
  readonly target: string;
  readonly at: string;
}
export interface BusinessWorkspaceTransaction {
  readonly now: string;
  get(): Promise<WorkspaceState | undefined>;
  save(state: WorkspaceState, event: WorkspaceAuditEvent): Promise<void>;
}
export interface BusinessWorkspaceBackend {
  /** Candidate lookup only; the encrypted workspace state remains permission authority. */
  findMemberships(
    subject: string,
    input: { readonly after?: string; readonly limit: number },
  ): Promise<readonly string[]>;
  /** Snapshot read; inherits a caller's authority transaction when one is already active. */
  read(org: string): Promise<WorkspaceState | undefined>;
  /** Uses the same organization authority lock as draft writes and publication. */
  run<T>(org: string, work: (tx: BusinessWorkspaceTransaction) => Promise<T>): Promise<T>;
}
export class BusinessWorkspaceError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'forbidden'
      | 'legacy_authority'
      | 'already_activated'
      | 'revision_conflict'
      | 'not_found'
      | 'last_owner'
      | 'invalid_invitation'
      | 'member_exists'
      | 'workspace_limit',
    readonly currentRevision?: number,
  ) {
    super(code);
    this.name = 'BusinessWorkspaceError';
  }
}

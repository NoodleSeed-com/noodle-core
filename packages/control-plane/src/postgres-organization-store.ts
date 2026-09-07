import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  CreateOrgWithOwnerInput,
  OrgDomainRecord,
  OrgInvitationRecord,
  OrgMemberRecord,
  OrgOpenAIAppsChallengeRecord,
  OrgRecord,
  OrgRole,
  SignupAllowlistKind,
  SignupAllowlistRecord,
  WelcomeEmailRecord,
} from './contracts.js';
import { PersonalWorkspaceOwnerMutationError } from './contracts.js';
import type { OrganizationProvisioningTx } from './postgres-contracts.js';
import {
  validateDomain,
  validateOpenAIAppsChallenge,
  validateOrgMembershipDomain,
  validateOrgRole,
  validateSignupAllowlistKind,
  validateSlug,
  validateUserOwnedOrgSlug,
} from './validation.js';

export async function createOrgRow(
  pool: Pool,
  input: { readonly slug: string; readonly displayName?: string },
): Promise<OrgRecord> {
  const slug = validateSlug('org', input.slug);
  const { rows } = await pool.query<OrgRow>(
    `INSERT INTO orgs (slug, display_name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, orgs.display_name)
     RETURNING *`,
    [slug, input.displayName ?? null],
  );
  return orgRowToRecord(rows[0] as OrgRow);
}

export async function claimWelcomeEmailRow(
  pool: Pool,
  input: { readonly now: Date; readonly leaseMs: number },
): Promise<WelcomeEmailRecord | undefined> {
  const { rows } = await pool.query<WelcomeEmailRow>(
    `WITH claimable AS (
       SELECT subject
       FROM welcome_email_outbox
       WHERE sent_at IS NULL
         AND next_attempt_at <= $1
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE welcome_email_outbox AS outbox
     SET lease_expires_at = $2, attempt_count = attempt_count + 1
     FROM claimable
     WHERE outbox.subject = claimable.subject
     RETURNING outbox.*`,
    [input.now, new Date(input.now.getTime() + input.leaseMs)],
  );
  return rows[0] ? welcomeEmailRowToRecord(rows[0]) : undefined;
}

export async function markWelcomeEmailSentRow(
  pool: Pool,
  input: { readonly subject: string; readonly providerMessageId: string },
): Promise<void> {
  await pool.query(
    `UPDATE welcome_email_outbox
     SET sent_at = now(), provider_message_id = $2, lease_expires_at = NULL, last_error_code = NULL
     WHERE subject = $1`,
    [input.subject, input.providerMessageId],
  );
}

export async function markWelcomeEmailFailedRow(
  pool: Pool,
  input: { readonly subject: string; readonly nextAttemptAt: Date },
): Promise<void> {
  await pool.query(
    `UPDATE welcome_email_outbox
     SET next_attempt_at = $2, lease_expires_at = NULL, last_error_code = 'delivery_failed'
     WHERE subject = $1`,
    [input.subject, input.nextAttemptAt],
  );
}

export async function getWelcomeEmailRow(
  pool: Pool,
  subject: string,
): Promise<WelcomeEmailRecord | undefined> {
  const { rows } = await pool.query<WelcomeEmailRow>(
    'SELECT * FROM welcome_email_outbox WHERE subject = $1',
    [subject],
  );
  return rows[0] ? welcomeEmailRowToRecord(rows[0]) : undefined;
}

export async function createOrgWithOwnerRow(
  pool: Pool,
  input: CreateOrgWithOwnerInput,
  now: () => Date,
  provisionOrganization: OrganizationProvisioningTx = async () => undefined,
): Promise<OrgRecord> {
  const slug = validateUserOwnedOrgSlug(input.slug);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The upsert locks this org row until commit. Concurrent creator requests for the same slug therefore
    // serialize before checking for an owner and cannot both claim an ownerless organization.
    const { rows } = await client.query<OrgRow>(
      `INSERT INTO orgs (slug, display_name)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, orgs.display_name)
       RETURNING *`,
      [slug, input.displayName ?? null],
    );
    const { rows: ownerRows } = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM org_members WHERE org_slug = $1 AND role = 'owner'
       ) AS exists`,
      [slug],
    );
    if (!(ownerRows[0]?.exists ?? false)) {
      await client.query(
        `INSERT INTO org_members (org_slug, subject, email, role)
         VALUES ($1, $2, $3, 'owner')
         ON CONFLICT (org_slug, subject) DO UPDATE SET
           email = EXCLUDED.email,
           role = 'owner'`,
        [slug, input.owner.subject, input.owner.email.toLowerCase()],
      );
      const billingCreatedAt = now();
      await provisionOrganization(
        client,
        {
          org: slug,
          owner: input.owner,
          reason: 'organization-created',
        },
        billingCreatedAt,
      );
    }
    await client.query('COMMIT');
    return orgRowToRecord(rows[0] as OrgRow);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getOrgRow(pool: Pool, slug: string): Promise<OrgRecord | undefined> {
  const { rows } = await pool.query<OrgRow>('SELECT * FROM orgs WHERE slug = $1', [
    validateSlug('org', slug),
  ]);
  return rows[0] ? orgRowToRecord(rows[0]) : undefined;
}

export async function updateOrgRow(
  pool: Pool,
  input: { readonly slug: string; readonly displayName: string },
): Promise<OrgRecord | undefined> {
  const { rows } = await pool.query<OrgRow>(
    'UPDATE orgs SET display_name = $2 WHERE slug = $1 RETURNING *',
    [validateSlug('org', input.slug), input.displayName],
  );
  return rows[0] ? orgRowToRecord(rows[0]) : undefined;
}

export async function listOrgRows(pool: Pool): Promise<readonly OrgRecord[]> {
  const { rows } = await pool.query<OrgRow>('SELECT * FROM orgs ORDER BY slug');
  return rows.map(orgRowToRecord);
}

export async function listOrgRowsForSubject(
  pool: Pool,
  subject: string,
): Promise<readonly OrgRecord[]> {
  const { rows } = await pool.query<OrgRow>(
    `SELECT orgs.*
     FROM orgs
     JOIN org_members ON org_members.org_slug = orgs.slug
     WHERE org_members.subject = $1
     ORDER BY orgs.slug`,
    [subject],
  );
  return rows.map(orgRowToRecord);
}

export async function addOrgMemberRow(
  pool: Pool,
  input: {
    readonly org: string;
    readonly subject: string;
    readonly email: string;
    readonly role: OrgRole;
  },
): Promise<OrgMemberRecord> {
  const org = validateSlug('org', input.org);
  const role = validateOrgRole(input.role);
  await createOrgRow(pool, { slug: org });
  try {
    const { rows } = await pool.query<OrgMemberRow>(
      `INSERT INTO org_members (org_slug, subject, email, role)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (org_slug, subject) DO UPDATE SET
         email = EXCLUDED.email,
         role = EXCLUDED.role
       RETURNING *`,
      [org, input.subject, input.email.toLowerCase(), role],
    );
    return memberRowToRecord(rows[0] as OrgMemberRow);
  } catch (error) {
    rethrowPersonalWorkspaceOwnerMutation(error);
  }
}

export async function removeOrgMemberRow(
  pool: Pool,
  input: { readonly org: string; readonly subject: string },
): Promise<boolean> {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM org_members WHERE org_slug = $1 AND subject = $2',
      [validateSlug('org', input.org), input.subject],
    );
    return (rowCount ?? 0) > 0;
  } catch (error) {
    rethrowPersonalWorkspaceOwnerMutation(error);
  }
}

export async function updateOrgMemberRoleRow(
  pool: Pool,
  input: { readonly org: string; readonly subject: string; readonly role: OrgRole },
): Promise<OrgMemberRecord | undefined> {
  try {
    const { rows } = await pool.query<OrgMemberRow>(
      'UPDATE org_members SET role = $3 WHERE org_slug = $1 AND subject = $2 RETURNING *',
      [validateSlug('org', input.org), input.subject, validateOrgRole(input.role)],
    );
    return rows[0] ? memberRowToRecord(rows[0]) : undefined;
  } catch (error) {
    rethrowPersonalWorkspaceOwnerMutation(error);
  }
}

function rethrowPersonalWorkspaceOwnerMutation(error: unknown): never {
  const databaseError = error as { readonly code?: unknown; readonly constraint?: unknown };
  if (
    databaseError.code === '23514' &&
    databaseError.constraint === 'personal_workspace_owner_immutable'
  ) {
    throw new PersonalWorkspaceOwnerMutationError();
  }
  throw error;
}

export async function getOrgMemberRow(
  pool: Pool,
  input: { readonly org: string; readonly subject: string },
): Promise<OrgMemberRecord | undefined> {
  const { rows } = await pool.query<OrgMemberRow>(
    'SELECT * FROM org_members WHERE org_slug = $1 AND subject = $2',
    [validateSlug('org', input.org), input.subject],
  );
  return rows[0] ? memberRowToRecord(rows[0]) : undefined;
}

export async function listOrgMemberRows(
  pool: Pool,
  org: string,
): Promise<readonly OrgMemberRecord[]> {
  const { rows } = await pool.query<OrgMemberRow>(
    'SELECT * FROM org_members WHERE org_slug = $1 ORDER BY email',
    [validateSlug('org', org)],
  );
  return rows.map(memberRowToRecord);
}

export async function isOrgMemberRow(
  pool: Pool,
  input: { readonly org: string; readonly subject: string },
): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM org_members WHERE org_slug = $1 AND subject = $2)',
    [validateSlug('org', input.org), input.subject],
  );
  return rows[0]?.exists ?? false;
}

export async function addOrgDomainRow(
  pool: Pool,
  input: { readonly org: string; readonly domain: string; readonly challenge?: string },
): Promise<OrgDomainRecord> {
  const org = validateSlug('org', input.org);
  const domain = validateOrgMembershipDomain(input.domain);
  const { rows } = await pool.query<OrgDomainRow>(
    `INSERT INTO org_domains (org_slug, domain, challenge)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_slug, domain) DO UPDATE SET
       challenge = org_domains.challenge
     RETURNING *`,
    [org, domain, input.challenge ?? `noodle-${randomUUID()}`],
  );
  return domainRowToRecord(rows[0] as OrgDomainRow);
}

export async function markOrgDomainVerificationRow(
  pool: Pool,
  now: () => Date,
  input: { readonly org: string; readonly domain: string; readonly verified: boolean },
): Promise<OrgDomainRecord | undefined> {
  const { rows } = await pool.query<OrgDomainRow>(
    `UPDATE org_domains
     SET last_checked_at = $3,
         verified_at = CASE WHEN $4 THEN COALESCE(verified_at, $3) ELSE NULL END
     WHERE org_slug = $1 AND domain = $2
     RETURNING *`,
    [validateSlug('org', input.org), validateDomain(input.domain), now(), input.verified],
  );
  return rows[0] ? domainRowToRecord(rows[0]) : undefined;
}

export async function removeOrgDomainRow(
  pool: Pool,
  input: { readonly org: string; readonly domain: string },
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM org_domains WHERE org_slug = $1 AND domain = $2',
    [validateSlug('org', input.org), validateDomain(input.domain)],
  );
  return (rowCount ?? 0) > 0;
}

export async function listOrgDomainRows(
  pool: Pool,
  org: string,
): Promise<readonly OrgDomainRecord[]> {
  const { rows } = await pool.query<OrgDomainRow>(
    'SELECT * FROM org_domains WHERE org_slug = $1 ORDER BY domain',
    [validateSlug('org', org)],
  );
  return rows.map(domainRowToRecord);
}

export async function setOrgOpenAIAppsChallengeRow(
  pool: Pool,
  input: {
    readonly org: string;
    readonly challenge: string;
    readonly updatedBySubject?: string;
    readonly updatedByEmail?: string;
  },
): Promise<OrgOpenAIAppsChallengeRecord> {
  const org = validateSlug('org', input.org);
  await createOrgRow(pool, { slug: org });
  const { rows } = await pool.query<OrgOpenAIAppsChallengeRow>(
    `INSERT INTO org_openai_apps_challenges (
       org_slug,
       challenge,
       updated_by_subject,
       updated_by_email
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_slug) DO UPDATE SET
       challenge = EXCLUDED.challenge,
       updated_at = now(),
       updated_by_subject = COALESCE(
         EXCLUDED.updated_by_subject,
         org_openai_apps_challenges.updated_by_subject
       ),
       updated_by_email = COALESCE(
         EXCLUDED.updated_by_email,
         org_openai_apps_challenges.updated_by_email
       )
     RETURNING *`,
    [
      org,
      validateOpenAIAppsChallenge(input.challenge),
      input.updatedBySubject ?? null,
      input.updatedByEmail ?? null,
    ],
  );
  return openAIAppsChallengeRowToRecord(rows[0] as OrgOpenAIAppsChallengeRow);
}

export async function getOrgOpenAIAppsChallengeRow(
  pool: Pool,
  org: string,
): Promise<OrgOpenAIAppsChallengeRecord | undefined> {
  const { rows } = await pool.query<OrgOpenAIAppsChallengeRow>(
    'SELECT * FROM org_openai_apps_challenges WHERE org_slug = $1',
    [validateSlug('org', org)],
  );
  return rows[0] ? openAIAppsChallengeRowToRecord(rows[0]) : undefined;
}

export async function clearOrgOpenAIAppsChallengeRow(pool: Pool, org: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM org_openai_apps_challenges WHERE org_slug = $1',
    [validateSlug('org', org)],
  );
  return (rowCount ?? 0) > 0;
}

export async function hasOrgDomainMembership(
  pool: Pool,
  input: { readonly org: string; readonly email: string },
): Promise<boolean> {
  const at = input.email.lastIndexOf('@');
  if (at < 0) return false;
  let domain: string;
  try {
    domain = validateDomain(input.email.slice(at + 1));
  } catch {
    return false;
  }
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM org_domains
       WHERE org_slug = $1 AND domain = $2
     )`,
    [validateSlug('org', input.org), domain],
  );
  return rows[0]?.exists ?? false;
}

export async function allowSignupRow(
  pool: Pool,
  input: {
    readonly kind: SignupAllowlistKind;
    readonly value: string;
    readonly createdBySubject?: string;
  },
): Promise<SignupAllowlistRecord> {
  const kind = validateSignupAllowlistKind(input.kind);
  const value = kind === 'domain' ? validateDomain(input.value) : input.value.trim().toLowerCase();
  const { rows } = await pool.query<SignupAllowlistRow>(
    `INSERT INTO signup_allowlist (kind, value, created_by_subject)
     VALUES ($1, $2, $3)
     ON CONFLICT (kind, value) DO UPDATE SET value = signup_allowlist.value
     RETURNING *`,
    [kind, value, input.createdBySubject ?? null],
  );
  return signupRowToRecord(rows[0] as SignupAllowlistRow);
}

export async function listSignupAllowlistRows(
  pool: Pool,
): Promise<readonly SignupAllowlistRecord[]> {
  const { rows } = await pool.query<SignupAllowlistRow>(
    'SELECT * FROM signup_allowlist ORDER BY kind, value',
  );
  return rows.map(signupRowToRecord);
}

export async function isSignupAllowedByRows(
  pool: Pool,
  input: { readonly subject: string; readonly email: string },
): Promise<boolean> {
  const subject = input.subject.toLowerCase();
  const at = input.email.lastIndexOf('@');
  const domain = at >= 0 ? input.email.slice(at + 1).toLowerCase() : '';
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM signup_allowlist
       WHERE (kind = 'subject' AND value = $1)
          OR (kind = 'domain' AND value = $2)
     )`,
    [subject, domain],
  );
  return rows[0]?.exists ?? false;
}

export async function createOrgInvitationRow(
  pool: Pool,
  now: () => Date,
  input: {
    readonly org: string;
    readonly email: string;
    readonly role: OrgRole;
    readonly tokenHash: string;
    readonly createdBySubject: string;
    readonly createdByEmail?: string;
    readonly expiresAt: Date;
  },
): Promise<OrgInvitationRecord> {
  const org = validateSlug('org', input.org);
  await createOrgRow(pool, { slug: org });
  const { rows } = await pool.query<OrgInvitationRow>(
    `INSERT INTO org_invitations
       (token_hash, org_slug, email, role, created_at, expires_at, created_by_subject, created_by_email)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.tokenHash,
      org,
      input.email.toLowerCase(),
      validateOrgRole(input.role),
      now(),
      input.expiresAt,
      input.createdBySubject,
      input.createdByEmail ?? null,
    ],
  );
  return invitationRowToRecord(rows[0] as OrgInvitationRow);
}

export async function getOrgInvitationRow(
  pool: Pool,
  now: () => Date,
  input: { readonly tokenHash: string },
): Promise<OrgInvitationRecord | undefined> {
  const { rows } = await pool.query<OrgInvitationRow>(
    `SELECT * FROM org_invitations
     WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2`,
    [input.tokenHash, now()],
  );
  return rows[0] ? invitationRowToRecord(rows[0]) : undefined;
}

export async function consumeOrgInvitationRow(
  pool: Pool,
  now: () => Date,
  input: { readonly tokenHash: string },
): Promise<OrgInvitationRecord | undefined> {
  const { rows } = await pool.query<OrgInvitationRow>(
    `UPDATE org_invitations
     SET accepted_at = $2
     WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > $2
     RETURNING *`,
    [input.tokenHash, now()],
  );
  return rows[0] ? invitationRowToRecord(rows[0]) : undefined;
}

export async function listOrgInvitationRows(
  pool: Pool,
  org: string,
): Promise<readonly OrgInvitationRecord[]> {
  const { rows } = await pool.query<OrgInvitationRow>(
    'SELECT * FROM org_invitations WHERE org_slug = $1 ORDER BY created_at DESC, email',
    [validateSlug('org', org)],
  );
  return rows.map(invitationRowToRecord);
}

export async function revokeOrgInvitationRows(
  pool: Pool,
  input: { readonly org: string; readonly email: string },
): Promise<number> {
  const { rowCount } = await pool.query(
    'DELETE FROM org_invitations WHERE org_slug = $1 AND email = $2 AND accepted_at IS NULL',
    [validateSlug('org', input.org), input.email.toLowerCase()],
  );
  return rowCount ?? 0;
}

interface OrgRow {
  readonly slug: string;
  readonly display_name: string | null;
  readonly created_at: Date;
}

interface OrgMemberRow {
  readonly org_slug: string;
  readonly subject: string;
  readonly email: string;
  readonly role: string;
  readonly created_at: Date;
}

interface OrgDomainRow {
  readonly org_slug: string;
  readonly domain: string;
  readonly challenge: string;
  readonly created_at: Date;
  readonly verified_at: Date | null;
  readonly last_checked_at: Date | null;
}

interface OrgOpenAIAppsChallengeRow {
  readonly org_slug: string;
  readonly challenge: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string | null;
  readonly updated_by_email: string | null;
}

interface SignupAllowlistRow {
  readonly kind: string;
  readonly value: string;
  readonly created_at: Date;
  readonly created_by_subject: string | null;
}

interface OrgInvitationRow {
  readonly token_hash: string;
  readonly org_slug: string;
  readonly email: string;
  readonly role: string;
  readonly created_at: Date;
  readonly expires_at: Date;
  readonly created_by_subject: string;
  readonly created_by_email: string | null;
  readonly accepted_at: Date | null;
}

interface WelcomeEmailRow {
  readonly subject: string;
  readonly email: string;
  readonly first_name: string | null;
  readonly created_at: Date;
  readonly attempt_count: number;
  readonly next_attempt_at: Date;
  readonly lease_expires_at: Date | null;
  readonly sent_at: Date | null;
  readonly provider_message_id: string | null;
  readonly last_error_code: string | null;
}

function orgRowToRecord(row: OrgRow): OrgRecord {
  return {
    slug: row.slug,
    ...(row.display_name !== null ? { displayName: row.display_name } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function memberRowToRecord(row: OrgMemberRow): OrgMemberRecord {
  return {
    orgSlug: row.org_slug,
    subject: row.subject,
    email: row.email,
    role: validateOrgRole(row.role),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function domainRowToRecord(row: OrgDomainRow): OrgDomainRecord {
  return {
    orgSlug: row.org_slug,
    domain: row.domain,
    challenge: row.challenge,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.verified_at !== null ? { verifiedAt: new Date(row.verified_at).toISOString() } : {}),
    ...(row.last_checked_at !== null
      ? { lastCheckedAt: new Date(row.last_checked_at).toISOString() }
      : {}),
  };
}

function openAIAppsChallengeRowToRecord(
  row: OrgOpenAIAppsChallengeRow,
): OrgOpenAIAppsChallengeRecord {
  return {
    orgSlug: row.org_slug,
    challenge: row.challenge,
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.updated_by_subject !== null ? { updatedBySubject: row.updated_by_subject } : {}),
    ...(row.updated_by_email !== null ? { updatedByEmail: row.updated_by_email } : {}),
  };
}

function signupRowToRecord(row: SignupAllowlistRow): SignupAllowlistRecord {
  return {
    kind: validateSignupAllowlistKind(row.kind),
    value: row.value,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.created_by_subject !== null ? { createdBySubject: row.created_by_subject } : {}),
  };
}

function invitationRowToRecord(row: OrgInvitationRow): OrgInvitationRecord {
  return {
    tokenHash: row.token_hash,
    orgSlug: row.org_slug,
    email: row.email,
    role: validateOrgRole(row.role),
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    createdBySubject: row.created_by_subject,
    ...(row.created_by_email !== null ? { createdByEmail: row.created_by_email } : {}),
    ...(row.accepted_at !== null ? { acceptedAt: new Date(row.accepted_at).toISOString() } : {}),
  };
}

function welcomeEmailRowToRecord(row: WelcomeEmailRow): WelcomeEmailRecord {
  return {
    subject: row.subject,
    email: row.email,
    ...(row.first_name !== null ? { firstName: row.first_name } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    attemptCount: row.attempt_count,
    nextAttemptAt: new Date(row.next_attempt_at).toISOString(),
    ...(row.lease_expires_at !== null
      ? { leaseExpiresAt: new Date(row.lease_expires_at).toISOString() }
      : {}),
    ...(row.sent_at !== null ? { sentAt: new Date(row.sent_at).toISOString() } : {}),
    ...(row.provider_message_id !== null ? { providerMessageId: row.provider_message_id } : {}),
    ...(row.last_error_code === 'delivery_failed' ? { lastErrorCode: 'delivery_failed' } : {}),
  };
}

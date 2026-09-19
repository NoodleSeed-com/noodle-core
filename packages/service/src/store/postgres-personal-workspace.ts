import {
  type OrganizationProvisioningTx,
  type OrgRecord,
  type PersonalWorkspaceProvisionInput,
  type PersonalWorkspaceProvisionResult,
  personalOrgSlugSuffix,
  validateUserOwnedOrgSlug,
} from '@noodle-borg/control-plane';
import type { Pool, PoolClient } from 'pg';
import { withPostgresTransaction } from './postgres-transaction.js';

/** Fresh-only participant: must use this pool's borrowed transaction; never repair legacy authority. */
export type PersonalWorkspaceCreated = (input: {
  readonly org: string;
  readonly ownerSubject: string;
}) => Promise<void>;

/** Atomically binds one canonical principal to one immutable personal organization. */
export async function provisionPersonalWorkspaceRow(
  pool: Pool,
  input: PersonalWorkspaceProvisionInput,
  now: () => Date,
  provisionOrganization: OrganizationProvisioningTx = async () => undefined,
  personalWorkspaceCreated?: PersonalWorkspaceCreated,
): Promise<PersonalWorkspaceProvisionResult> {
  const requestedSlug = validateUserOwnedOrgSlug(input.slug);
  return withPostgresTransaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `personal-workspace:${input.subject}`,
    ]);
    const binding = await loadBinding(client, input.subject);
    if (binding !== undefined) {
      // The immutable binding is the canonical ownership record. Repair legacy member drift before
      // commercial provisioning so an already-authorized billing transfer remains authoritative.
      await ensureOwnerMembership(client, binding.org_slug, input);
      await provision(client, binding.org_slug, input, now, provisionOrganization);
      return { org: orgFromRow(binding), created: false };
    }

    const candidates = await loadLegacyCandidates(
      client,
      personalOrgSlugSuffix(input.subject),
      input.subject,
    );
    if (candidates.length > 1) throw new Error('personal workspace legacy mapping is ambiguous');
    const legacy = candidates[0];
    if (legacy !== undefined) {
      await ensureOwnerMembership(client, legacy.slug, input);
      await provision(client, legacy.slug, input, now, provisionOrganization);
      await insertBinding(client, input.subject, legacy.slug);
      return { org: orgFromRow(legacy), created: false };
    }

    const inserted = await client.query<OrgRow>(
      `INSERT INTO orgs (slug, display_name)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [requestedSlug, input.displayName],
    );
    const org = inserted.rows[0];
    if (org === undefined) throw new Error('personal workspace slug is already assigned');
    await ensureOwnerMembership(client, requestedSlug, input);
    const createdAt = now();
    await provisionOrganization(
      client,
      {
        org: requestedSlug,
        owner: {
          ...(input.identityIssuer === undefined ? {} : { identityIssuer: input.identityIssuer }),
          subject: input.subject,
          email: input.email,
        },
        reason: 'personal-workspace-created',
      },
      createdAt,
    );
    await personalWorkspaceCreated?.({ org: requestedSlug, ownerSubject: input.subject });
    await client.query(
      `INSERT INTO welcome_email_outbox
         (subject, org_slug, email, first_name, created_at, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (subject) DO NOTHING`,
      [input.subject, requestedSlug, input.email.toLowerCase(), input.firstName ?? null, createdAt],
    );
    await insertBinding(client, input.subject, requestedSlug);
    return { org: orgFromRow(org), created: true };
  });
}

async function provision(
  client: PoolClient,
  org: string,
  input: PersonalWorkspaceProvisionInput,
  now: () => Date,
  hook: OrganizationProvisioningTx,
): Promise<void> {
  await hook(
    client,
    {
      org,
      owner: {
        ...(input.identityIssuer === undefined ? {} : { identityIssuer: input.identityIssuer }),
        subject: input.subject,
        email: input.email,
      },
      reason: 'personal-workspace-created',
    },
    now(),
  );
}

async function loadBinding(
  client: PoolClient,
  principalSubject: string,
): Promise<PersonalWorkspaceBindingRow | undefined> {
  const { rows } = await client.query<PersonalWorkspaceBindingRow>(
    `SELECT binding.principal_subject, binding.org_slug, org.slug,
            org.display_name, org.created_at
     FROM personal_workspace_bindings binding
     JOIN orgs org ON org.slug = binding.org_slug
     WHERE binding.principal_subject = $1
     FOR UPDATE OF binding, org`,
    [principalSubject],
  );
  return rows[0];
}

async function loadLegacyCandidates(
  client: PoolClient,
  suffix: string,
  subject: string,
): Promise<readonly OrgRow[]> {
  const { rows } = await client.query<OrgRow>(
    `SELECT org.slug, org.display_name, org.created_at
     FROM orgs org
     WHERE org.slug LIKE 'u-%'
       AND right(org.slug, length($1)) = $1
       AND EXISTS (
         SELECT 1 FROM org_members member
          WHERE member.org_slug = org.slug AND member.subject = $2 AND member.role = 'owner'
       )
     ORDER BY org.slug
     FOR UPDATE OF org`,
    [suffix, subject],
  );
  return rows;
}

async function ensureOwnerMembership(
  client: PoolClient,
  org: string,
  input: PersonalWorkspaceProvisionInput,
): Promise<void> {
  const result = await client.query(
    `INSERT INTO org_members (org_slug, subject, email, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (org_slug, subject) DO UPDATE SET email = EXCLUDED.email, role = 'owner'
     RETURNING subject`,
    [org, input.subject, input.email.toLowerCase()],
  );
  if (result.rows[0]?.subject !== input.subject) {
    throw new Error('personal workspace provisioning lost owner membership');
  }
}

async function insertBinding(client: PoolClient, subject: string, org: string): Promise<void> {
  await client.query(
    `INSERT INTO personal_workspace_bindings (principal_subject, org_slug)
     VALUES ($1, $2)`,
    [subject, org],
  );
}

interface OrgRow {
  readonly slug: string;
  readonly display_name: string | null;
  readonly created_at: Date;
}

interface PersonalWorkspaceBindingRow extends OrgRow {
  readonly principal_subject: string;
  readonly org_slug: string;
}

function orgFromRow(row: OrgRow): OrgRecord {
  return {
    slug: row.slug,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

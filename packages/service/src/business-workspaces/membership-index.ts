import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { postgresQueryExecutor, withPostgresTransaction } from '../store/postgres-transaction.js';
import type { WorkspaceState } from './contracts.js';

/** Rebuildable lookup, never role authority. No emails, invitation tokens or plaintext subjects. */
export function membershipDigest(subject: string): string {
  return createHash('sha256').update(subject).digest('hex');
}

export async function indexWorkspaceMemberships(
  client: PoolClient,
  state: WorkspaceState,
): Promise<void> {
  await client.query('DELETE FROM business_workspace_membership_index WHERE org = $1', [state.org]);
  await client.query(
    `INSERT INTO business_workspace_membership_index (org, subject_digest, revision)
     SELECT $1, value, $2 FROM unnest($3::text[]) AS value`,
    [state.org, state.revision, state.members.map((member) => membershipDigest(member.subject))],
  );
}

/** Startup repairs missing/stale lookup generations from encrypted authority, one locked workspace at a time. */
export async function backfillMembershipIndex(
  pool: Pool,
  read: (org: string) => Promise<WorkspaceState | undefined>,
): Promise<void> {
  let after = '';
  for (;;) {
    const { rows } = await postgresQueryExecutor(pool).query<{ org: string }>(
      `SELECT authority.org FROM business_workspace_authority authority
       WHERE authority.org COLLATE "C" > $1 COLLATE "C" AND NOT EXISTS (
         SELECT 1 FROM business_workspace_membership_index lookup
         WHERE lookup.org = authority.org AND lookup.revision = authority.revision
       ) ORDER BY authority.org COLLATE "C" LIMIT 100`,
      [after],
    );
    for (const row of rows) {
      await withPostgresTransaction(pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `business-workspace:${row.org}`,
        ]);
        const state = await read(row.org);
        if (state) await indexWorkspaceMemberships(client, state);
      });
      after = row.org;
    }
    if (rows.length < 100) return;
  }
}

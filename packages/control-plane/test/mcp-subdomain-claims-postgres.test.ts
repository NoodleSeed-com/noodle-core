import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeMcpSubdomainRow,
  ensureOrganizationSchema,
  getActiveMcpSubdomainRow,
  getMcpSubdomainSettingRow,
  McpSubdomainCooldownError,
  McpSubdomainIdempotencyConflictError,
  McpSubdomainOwnerRequiredError,
  McpSubdomainUnavailableError,
  resolveActiveMcpSubdomainRow,
} from '../src/index.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `mcp_subdomain_claims_${process.pid}`;

describe.skipIf(!URL)('PostgreSQL MCP subdomain claims', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 3, options: `-c search_path=${SCHEMA}` });
    await pool.query(`
      CREATE TABLE orgs (
        slug text PRIMARY KEY,
        display_name text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await pool.query(`
      INSERT INTO orgs (slug) VALUES
        ('arez-internal'), ('other-org'), ('invariant-org'), ('race-one'), ('race-two'),
        ('rollback-org'), ('cooldown-org'), ('no-owner'), ('local')
    `);
    await ensureOrganizationSchema(pool);
    await pool.query(`
      INSERT INTO org_members (org_slug, subject, email, role)
      SELECT slug, 'owner-' || slug, 'owner-' || slug || '@example.com', 'owner'
      FROM orgs
      WHERE slug NOT IN ('local', 'no-owner')
    `);
    await pool.query(`
      CREATE TABLE mcp_subdomain_audit_probe (
        org_slug text NOT NULL,
        previous_subdomain text NOT NULL,
        current_subdomain text NOT NULL,
        actor_subject text NOT NULL
      )
    `);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('backfills hosted organizations, excludes local, and remains idempotent', async () => {
    await expect(getActiveMcpSubdomainRow(pool, 'arez-internal')).resolves.toMatchObject({
      mcpSubdomain: 'arez-internal',
      orgSlug: 'arez-internal',
    });
    await expect(resolveActiveMcpSubdomainRow(pool, 'other-org')).resolves.toMatchObject({
      orgSlug: 'other-org',
    });
    await expect(getActiveMcpSubdomainRow(pool, 'local')).resolves.toBeUndefined();

    await ensureOrganizationSchema(pool);
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM org_mcp_subdomain_claims WHERE state = 'active'`,
    );
    expect(rows[0]?.count).toBe('8');
  });

  it('atomically creates a default claim for raw organization inserts', async () => {
    await pool.query(`INSERT INTO orgs (slug) VALUES ('new-org')`);
    await expect(resolveActiveMcpSubdomainRow(pool, 'new-org')).resolves.toMatchObject({
      mcpSubdomain: 'new-org',
      orgSlug: 'new-org',
    });
    await expect(pool.query(`INSERT INTO orgs (slug) VALUES ('Bad-Org')`)).rejects.toThrow();
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM orgs WHERE slug = 'Bad-Org') AS exists`,
    );
    expect(rows[0]?.exists).toBe(false);
  });

  it('changes immediately for an exact owner, records audit atomically, and replays safely', async () => {
    const input = mutation('arez-internal', 'arez', 'exact-replay-key');
    const first = await changeMcpSubdomainRow(pool, input, {
      now: () => new Date('2026-08-11T12:00:00.000Z'),
      recordAudit: insertAuditProbe,
    });

    expect(first).toEqual({
      orgSlug: 'arez-internal',
      previousMcpSubdomain: 'arez-internal',
      mcpSubdomain: 'arez',
      changed: true,
      replayed: false,
      changedAt: '2026-08-11T12:00:00.000Z',
      changeAllowedAt: '2026-09-10T12:00:00.000Z',
      auditCommitted: true,
    });
    await expect(getMcpSubdomainSettingRow(pool, 'arez-internal')).resolves.toMatchObject({
      mcpSubdomain: 'arez',
      changeAllowedAt: '2026-09-10T12:00:00.000Z',
    });
    await expect(resolveActiveMcpSubdomainRow(pool, 'arez-internal')).resolves.toBeUndefined();

    await expect(
      changeMcpSubdomainRow(pool, input, {
        now: () => new Date('2026-08-20T12:00:00.000Z'),
        recordAudit: insertAuditProbe,
      }),
    ).resolves.toEqual({ ...first, replayed: true });
    await expect(
      changeMcpSubdomainRow(pool, mutation('arez-internal', 'arez-next', 'exact-replay-key'), {
        recordAudit: insertAuditProbe,
      }),
    ).rejects.toBeInstanceOf(McpSubdomainIdempotencyConflictError);

    const { rows: auditRows } = await pool.query(`SELECT * FROM mcp_subdomain_audit_probe`);
    expect(auditRows).toEqual([
      {
        org_slug: 'arez-internal',
        previous_subdomain: 'arez-internal',
        current_subdomain: 'arez',
        actor_subject: 'owner-arez-internal',
      },
    ]);
  });

  it('keeps no-op and failed requests cooldown-neutral and enforces the exact boundary', async () => {
    const first = await changeMcpSubdomainRow(
      pool,
      mutation('cooldown-org', 'cooldown-one', 'cooldown-first'),
      { now: () => new Date('2026-08-11T12:00:00.000Z'), recordAudit: insertAuditProbe },
    );
    const noOp = await changeMcpSubdomainRow(
      pool,
      mutation('cooldown-org', 'cooldown-one', 'cooldown-noop'),
      { now: () => new Date('2026-08-20T12:00:00.000Z'), recordAudit: insertAuditProbe },
    );
    expect(noOp).toMatchObject({
      changed: false,
      changeAllowedAt: first.changeAllowedAt,
      auditCommitted: false,
    });

    await expect(
      changeMcpSubdomainRow(pool, mutation('cooldown-org', 'cooldown-two', 'cooldown-blocked'), {
        now: () => new Date('2026-09-10T11:59:59.999Z'),
        recordAudit: insertAuditProbe,
      }),
    ).rejects.toMatchObject({ changeAllowedAt: first.changeAllowedAt });
    await expect(
      changeMcpSubdomainRow(
        pool,
        mutation('cooldown-org', 'cooldown-two', 'cooldown-blocked-again'),
        { now: () => new Date('2026-09-10T11:59:59.999Z'), recordAudit: insertAuditProbe },
      ),
    ).rejects.toBeInstanceOf(McpSubdomainCooldownError);
    await expect(
      changeMcpSubdomainRow(pool, mutation('cooldown-org', 'cooldown-two', 'cooldown-boundary'), {
        now: () => new Date('2026-09-10T12:00:00.000Z'),
        recordAudit: insertAuditProbe,
      }),
    ).resolves.toMatchObject({ changed: true, mcpSubdomain: 'cooldown-two' });
  });

  it('denies missing exact ownership and masks active and retired collisions alike', async () => {
    await expect(
      changeMcpSubdomainRow(pool, mutation('no-owner', 'ownerless-change', 'ownerless')),
    ).rejects.toBeInstanceOf(McpSubdomainOwnerRequiredError);
    await expect(
      changeMcpSubdomainRow(pool, mutation('other-org', 'arez', 'active-collision')),
    ).rejects.toBeInstanceOf(McpSubdomainUnavailableError);
    await expect(
      changeMcpSubdomainRow(pool, mutation('other-org', 'arez-internal', 'retired-collision')),
    ).rejects.toBeInstanceOf(McpSubdomainUnavailableError);
  });

  it('arbitrates concurrent global claims and rolls injected failures back completely', async () => {
    const race = await Promise.allSettled([
      changeMcpSubdomainRow(pool, mutation('race-one', 'shared-label', 'race-one-key')),
      changeMcpSubdomainRow(pool, mutation('race-two', 'shared-label', 'race-two-key')),
    ]);
    expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(McpSubdomainUnavailableError),
    });

    await expect(
      changeMcpSubdomainRow(pool, mutation('rollback-org', 'rolled-back-label', 'rollback'), {
        now: () => new Date('2026-08-11T12:00:00.000Z'),
        recordAudit: async () => {
          throw new Error('injected audit failure');
        },
      }),
    ).rejects.toThrow('injected audit failure');
    await expect(getActiveMcpSubdomainRow(pool, 'rollback-org')).resolves.toMatchObject({
      mcpSubdomain: 'rollback-org',
    });
    await expect(resolveActiveMcpSubdomainRow(pool, 'rolled-back-label')).resolves.toBeUndefined();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM org_mcp_subdomain_mutations
       WHERE org_slug = 'rollback-org'`,
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('enforces global labels, one active claim, and append-only retirement', async () => {
    await expect(
      pool.query(
        `INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state)
         VALUES ('arez-internal', 'other-org', 'active')`,
      ),
    ).rejects.toThrow();
    await pool.query(
      `INSERT INTO org_mcp_subdomain_claims
         (subdomain, org_slug, state, retired_at, retired_by_principal)
       VALUES ('reserved-label', 'other-org', 'retired', now(), 'owner-sub')`,
    );
    await expect(pool.query(`INSERT INTO orgs (slug) VALUES ('reserved-label')`)).rejects.toThrow();
    const { rows: reservedOrgRows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM orgs WHERE slug = 'reserved-label') AS exists`,
    );
    expect(reservedOrgRows[0]?.exists).toBe(false);
    await expect(
      pool.query(
        `INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state)
         VALUES ('other-label', 'other-org', 'active')`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(`DELETE FROM org_mcp_subdomain_claims WHERE subdomain = 'invariant-org'`),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE org_mcp_subdomain_claims
         SET org_slug = 'other-org'
         WHERE subdomain = 'invariant-org'`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `UPDATE org_mcp_subdomain_claims
         SET state = 'retired'
         WHERE subdomain = 'invariant-org'`,
      ),
    ).rejects.toThrow();

    await pool.query(
      `UPDATE org_mcp_subdomain_claims
       SET state = 'retired', retired_at = now(), retired_by_principal = 'owner-sub'
       WHERE subdomain = 'invariant-org'`,
    );
    await expect(
      pool.query(
        `UPDATE org_mcp_subdomain_claims
         SET state = 'active', retired_at = NULL, retired_by_principal = NULL
         WHERE subdomain = 'invariant-org'`,
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state)
         VALUES ('invariant-org', 'invariant-org', 'active')`,
      ),
    ).rejects.toThrow();
  });

  it('pre-creates the durable mutation ledger without exposing mutation behavior', async () => {
    const { rows } = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('org_mcp_subdomain_mutations')::text AS name`,
    );
    expect(rows[0]?.name).toBe('org_mcp_subdomain_mutations');
  });

  it('fails schema startup when an existing hosted org cannot receive a valid claim', async () => {
    const invalidSchema = `${SCHEMA}_invalid`;
    await admin.query(`CREATE SCHEMA ${invalidSchema}`);
    const invalidPool = new Pool({
      connectionString: URL,
      max: 1,
      options: `-c search_path=${invalidSchema}`,
    });
    try {
      await invalidPool.query(`
        CREATE TABLE orgs (
          slug text PRIMARY KEY,
          display_name text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await invalidPool.query(`INSERT INTO orgs (slug) VALUES ('Invalid-Org')`);
      await expect(ensureOrganizationSchema(invalidPool)).rejects.toThrow();
    } finally {
      await invalidPool.end();
      await admin.query(`DROP SCHEMA ${invalidSchema} CASCADE`);
    }
  });
});

function mutation(org: string, mcpSubdomain: string, idempotencyKey: string) {
  return {
    org,
    mcpSubdomain,
    idempotencyKey,
    actor: {
      subject: `owner-${org}`,
      email: `owner-${org}@example.com`,
    },
  };
}

async function insertAuditProbe(
  client: { query: Pool['query'] },
  result: {
    orgSlug: string;
    previousMcpSubdomain: string;
    mcpSubdomain: string;
  },
  input: { actor: { subject: string } },
): Promise<void> {
  await client.query(
    `INSERT INTO mcp_subdomain_audit_probe
       (org_slug, previous_subdomain, current_subdomain, actor_subject)
     VALUES ($1, $2, $3, $4)`,
    [result.orgSlug, result.previousMcpSubdomain, result.mcpSubdomain, input.actor.subject],
  );
}

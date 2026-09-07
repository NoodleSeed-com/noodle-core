import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ActiveMcpSubdomainClaim,
  ChangeMcpSubdomainInput,
  McpSubdomainMutationResult,
  McpSubdomainSetting,
} from './contracts.js';
import {
  McpSubdomainCooldownError,
  McpSubdomainIdempotencyConflictError,
  McpSubdomainOwnerRequiredError,
  McpSubdomainUnavailableError,
} from './mcp-subdomain-claims.js';
import { validateMcpSubdomain, validateSlug } from './validation.js';

const MCP_SUBDOMAIN_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

type ChangedMcpSubdomainResult = Omit<McpSubdomainMutationResult, 'changed' | 'changedAt'> & {
  readonly changed: true;
  readonly changedAt: string;
};

interface ActiveMcpSubdomainClaimRow {
  readonly subdomain: string;
  readonly org_slug: string;
  readonly claimed_at: Date | string;
}

interface McpSubdomainSettingRow extends ActiveMcpSubdomainClaimRow {
  readonly last_changed_at: Date | string | null;
}

interface McpSubdomainMutationRow {
  readonly request_fingerprint: string;
  readonly outcome: 'changed' | 'noop';
  readonly previous_subdomain: string;
  readonly current_subdomain: string;
  readonly recorded_at: Date | string;
  readonly changed_at: Date | string | null;
}

export interface PostgresMcpSubdomainMutationOptions {
  readonly now?: () => Date;
  /** Called after state and mutation rows are staged but before commit. */
  readonly recordAudit?: (
    client: Pick<PoolClient, 'query'>,
    result: ChangedMcpSubdomainResult,
    input: ChangeMcpSubdomainInput,
  ) => Promise<void>;
}

export async function getActiveMcpSubdomainRow(
  pool: Pool,
  org: string,
): Promise<ActiveMcpSubdomainClaim | undefined> {
  const { rows } = await pool.query<ActiveMcpSubdomainClaimRow>(
    `SELECT subdomain, org_slug, claimed_at
     FROM org_mcp_subdomain_claims
     WHERE org_slug = $1 AND state = 'active'`,
    [validateSlug('org', org)],
  );
  return rows[0] === undefined ? undefined : claimRowToRecord(rows[0]);
}

export async function resolveActiveMcpSubdomainRow(
  pool: Pool,
  mcpSubdomain: string,
): Promise<ActiveMcpSubdomainClaim | undefined> {
  const { rows } = await pool.query<ActiveMcpSubdomainClaimRow>(
    `SELECT subdomain, org_slug, claimed_at
     FROM org_mcp_subdomain_claims
     WHERE subdomain = $1 AND state = 'active'`,
    [validateMcpSubdomain(mcpSubdomain)],
  );
  return rows[0] === undefined ? undefined : claimRowToRecord(rows[0]);
}

export async function getMcpSubdomainSettingRow(
  pool: Pool,
  org: string,
): Promise<McpSubdomainSetting | undefined> {
  const { rows } = await pool.query<McpSubdomainSettingRow>(
    `SELECT claims.subdomain, claims.org_slug, claims.claimed_at,
       (SELECT max(changed_at)
        FROM org_mcp_subdomain_mutations
        WHERE org_slug = claims.org_slug AND outcome = 'changed') AS last_changed_at
     FROM org_mcp_subdomain_claims AS claims
     WHERE claims.org_slug = $1 AND claims.state = 'active'`,
    [validateSlug('org', org)],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const claim = claimRowToRecord(row);
  const changeAllowedAt = cooldownBoundary(row.last_changed_at);
  return { ...claim, ...(changeAllowedAt === undefined ? {} : { changeAllowedAt }) };
}

/** Exact-owner, globally unique, permanently retiring mutation in one PostgreSQL transaction. */
export async function changeMcpSubdomainRow(
  pool: Pool,
  input: ChangeMcpSubdomainInput,
  options: PostgresMcpSubdomainMutationOptions = {},
): Promise<McpSubdomainMutationResult> {
  const org = validateSlug('org', input.org);
  if (input.idempotencyKey.length === 0) throw new Error('idempotency key must not be empty');
  const keyHash = `sha256:${digest(input.idempotencyKey)}`;
  const fingerprint = `v1:${digest(input.mcpSubdomain)}`;
  const now = (options.now ?? (() => new Date()))();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount: orgCount } = await client.query(
      'SELECT slug FROM orgs WHERE slug = $1 FOR UPDATE',
      [org],
    );
    if (orgCount !== 1) throw new McpSubdomainOwnerRequiredError();
    const { rows: memberRows } = await client.query<{ role: string }>(
      `SELECT role FROM org_members
       WHERE org_slug = $1 AND subject = $2
       FOR UPDATE`,
      [org, input.actor.subject],
    );
    if (memberRows[0]?.role !== 'owner') throw new McpSubdomainOwnerRequiredError();

    const { rows: replayRows } = await client.query<McpSubdomainMutationRow>(
      `SELECT request_fingerprint, outcome, previous_subdomain, current_subdomain,
              recorded_at, changed_at
       FROM org_mcp_subdomain_mutations
       WHERE org_slug = $1 AND idempotency_key_hash = $2
       FOR UPDATE`,
      [org, keyHash],
    );
    const replay = replayRows[0];
    if (replay !== undefined) {
      if (replay.request_fingerprint !== fingerprint) {
        throw new McpSubdomainIdempotencyConflictError();
      }
      const result = await replayResult(client, org, replay);
      await client.query('COMMIT');
      return result;
    }

    const mcpSubdomain = validateMcpSubdomain(input.mcpSubdomain);
    const { rows: claimRows } = await client.query<ActiveMcpSubdomainClaimRow>(
      `SELECT subdomain, org_slug, claimed_at
       FROM org_mcp_subdomain_claims
       WHERE org_slug = $1 AND state = 'active'
       FOR UPDATE`,
      [org],
    );
    const current = claimRows[0];
    if (current === undefined) {
      throw new Error(`active MCP subdomain claim missing for organization "${org}"`);
    }
    const lastChangedAt = await latestChangedAt(client, org);
    const changeAllowedAt = cooldownBoundary(lastChangedAt);
    if (mcpSubdomain === current.subdomain) {
      await client.query(
        `INSERT INTO org_mcp_subdomain_mutations
           (org_slug, idempotency_key_hash, request_fingerprint, outcome,
            previous_subdomain, current_subdomain, actor_principal_id, recorded_at, changed_at)
         VALUES ($1, $2, $3, 'noop', $4, $4, $5, $6, NULL)`,
        [org, keyHash, fingerprint, current.subdomain, input.actor.subject, now],
      );
      const result: McpSubdomainMutationResult = {
        orgSlug: org,
        previousMcpSubdomain: current.subdomain,
        mcpSubdomain,
        changed: false,
        replayed: false,
        ...(changeAllowedAt === undefined ? {} : { changeAllowedAt }),
        auditCommitted: false,
      };
      await client.query('COMMIT');
      return result;
    }
    if (changeAllowedAt !== undefined && now.getTime() < Date.parse(changeAllowedAt)) {
      throw new McpSubdomainCooldownError(changeAllowedAt);
    }

    await client.query(
      `UPDATE org_mcp_subdomain_claims
       SET state = 'retired', retired_at = $2, retired_by_principal = $3
       WHERE org_slug = $1 AND state = 'active'`,
      [org, now, input.actor.subject],
    );
    await client.query(
      `INSERT INTO org_mcp_subdomain_claims (subdomain, org_slug, state, claimed_at)
       VALUES ($1, $2, 'active', $3)`,
      [mcpSubdomain, org, now],
    );
    await client.query(
      `INSERT INTO org_mcp_subdomain_mutations
         (org_slug, idempotency_key_hash, request_fingerprint, outcome,
          previous_subdomain, current_subdomain, actor_principal_id, recorded_at, changed_at)
       VALUES ($1, $2, $3, 'changed', $4, $5, $6, $7, $7)`,
      [org, keyHash, fingerprint, current.subdomain, mcpSubdomain, input.actor.subject, now],
    );
    const changedAt = now.toISOString();
    const result: ChangedMcpSubdomainResult = {
      orgSlug: org,
      previousMcpSubdomain: current.subdomain,
      mcpSubdomain,
      changed: true,
      replayed: false,
      changedAt,
      changeAllowedAt: new Date(now.getTime() + MCP_SUBDOMAIN_COOLDOWN_MS).toISOString(),
      auditCommitted: options.recordAudit !== undefined,
    };
    if (options.recordAudit !== undefined) await options.recordAudit(client, result, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (isUniqueViolation(error)) throw new McpSubdomainUnavailableError();
    throw error;
  } finally {
    client.release();
  }
}

async function replayResult(
  client: Pick<PoolClient, 'query'>,
  org: string,
  row: McpSubdomainMutationRow,
): Promise<McpSubdomainMutationResult> {
  const changed = row.outcome === 'changed';
  const changedAt = row.changed_at === null ? undefined : new Date(row.changed_at).toISOString();
  const priorChangedAt = changed
    ? row.changed_at
    : await latestChangedAt(client, org, new Date(row.recorded_at));
  const changeAllowedAt = cooldownBoundary(priorChangedAt);
  return {
    orgSlug: org,
    previousMcpSubdomain: row.previous_subdomain,
    mcpSubdomain: row.current_subdomain,
    changed,
    replayed: true,
    ...(changedAt === undefined ? {} : { changedAt }),
    ...(changeAllowedAt === undefined ? {} : { changeAllowedAt }),
    auditCommitted: changed,
  };
}

async function latestChangedAt(
  queryable: Pick<PoolClient, 'query'>,
  org: string,
  atOrBefore?: Date,
): Promise<Date | string | null> {
  const { rows } = await queryable.query<{ changed_at: Date | string | null }>(
    `SELECT max(changed_at) AS changed_at
     FROM org_mcp_subdomain_mutations
     WHERE org_slug = $1 AND outcome = 'changed'
       AND ($2::timestamptz IS NULL OR changed_at <= $2)`,
    [org, atOrBefore ?? null],
  );
  return rows[0]?.changed_at ?? null;
}

function cooldownBoundary(value: Date | string | null): string | undefined {
  return value === null
    ? undefined
    : new Date(new Date(value).getTime() + MCP_SUBDOMAIN_COOLDOWN_MS).toISOString();
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function claimRowToRecord(row: ActiveMcpSubdomainClaimRow): ActiveMcpSubdomainClaim {
  return {
    mcpSubdomain: row.subdomain,
    orgSlug: row.org_slug,
    claimedAt: new Date(row.claimed_at).toISOString(),
  };
}

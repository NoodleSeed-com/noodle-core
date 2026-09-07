import type { Pool } from 'pg';
import type { TenantRef } from '../store.js';
import {
  type AlertFiringState,
  type AlertMetric,
  type AlertRuleRecord,
  type AlertRuleStore,
  type AlertWindowMinutes,
  type CreateAlertRuleInput,
  newAlertRuleRecord,
  validateAlertRuleId,
} from './alert-rules.js';
import { validateSlug } from './validate.js';

/**
 * Relational {@link AlertRuleStore} backend (analytics alerting E2), a standalone pool-injected
 * class mirroring `PostgresRequestEventStore` (the analytics-family precedent) rather than another
 * facet of `PostgresArtifactStore` — alert rules belong to the analytics surface and this keeps
 * `postgres.ts` under the size gate. Pure SQL; unit-testable against any local Postgres
 * (`DATABASE_URL_TEST`).
 */

/** Create the `alert_rules` table if absent (idempotent; run once at startup). */
export async function ensureAlertRuleSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id                 uuid PRIMARY KEY,
      org_slug           text NOT NULL,
      app_slug           text NOT NULL,
      environment        text NOT NULL,
      name               text,
      metric             text NOT NULL,
      threshold          double precision NOT NULL,
      window_minutes     int NOT NULL,
      comparison         text NOT NULL DEFAULT '>=',
      webhook_url        text NOT NULL,
      enabled            boolean NOT NULL DEFAULT true,
      cooldown_minutes   int NOT NULL,
      breaching          boolean NOT NULL DEFAULT false,
      last_observed      double precision,
      last_fired_at      timestamptz,
      created_by_subject text,
      created_at         timestamptz NOT NULL,
      updated_at         timestamptz NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS alert_rules_tenant_idx
      ON alert_rules (org_slug, app_slug, environment)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS alert_rules_enabled_idx
      ON alert_rules (enabled)
      WHERE enabled
  `);
}

interface AlertRuleRow {
  readonly id: string;
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly name: string | null;
  readonly metric: string;
  readonly threshold: number;
  readonly window_minutes: number;
  readonly comparison: string;
  readonly webhook_url: string;
  readonly enabled: boolean;
  readonly cooldown_minutes: number;
  readonly breaching: boolean;
  readonly last_observed: number | null;
  readonly last_fired_at: Date | null;
  readonly created_by_subject: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function rowToRecord(row: AlertRuleRow): AlertRuleRecord {
  return {
    id: row.id,
    orgSlug: row.org_slug,
    appSlug: row.app_slug,
    environment: row.environment,
    ...(row.name !== null ? { name: row.name } : {}),
    metric: row.metric as AlertMetric,
    threshold: Number(row.threshold),
    windowMinutes: Number(row.window_minutes) as AlertWindowMinutes,
    comparison: '>=',
    webhookUrl: row.webhook_url,
    enabled: row.enabled,
    cooldownMinutes: Number(row.cooldown_minutes),
    breaching: row.breaching,
    ...(row.last_observed !== null ? { lastObserved: Number(row.last_observed) } : {}),
    ...(row.last_fired_at !== null
      ? { lastFiredAt: new Date(row.last_fired_at).toISOString() }
      : {}),
    ...(row.created_by_subject !== null ? { createdBySubject: row.created_by_subject } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class PostgresAlertRuleStore implements AlertRuleStore {
  readonly #pool: Pool;
  readonly #now: () => Date;

  constructor(pool: Pool, options: { now?: () => Date } = {}) {
    this.#pool = pool;
    this.#now = options.now ?? (() => new Date());
  }

  async ensureSchema(): Promise<void> {
    await ensureAlertRuleSchema(this.#pool);
  }

  async createAlertRule(input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
    const record = newAlertRuleRecord(input, this.#now);
    await this.#pool.query(
      `INSERT INTO alert_rules
         (id, org_slug, app_slug, environment, name, metric, threshold, window_minutes,
          comparison, webhook_url, enabled, cooldown_minutes, breaching,
          created_by_subject, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, $14, $14)`,
      [
        record.id,
        record.orgSlug,
        record.appSlug,
        record.environment,
        record.name ?? null,
        record.metric,
        record.threshold,
        record.windowMinutes,
        record.comparison,
        record.webhookUrl,
        record.enabled,
        record.cooldownMinutes,
        record.createdBySubject ?? null,
        record.createdAt,
      ],
    );
    return record;
  }

  async listAlertRules(ref: TenantRef): Promise<readonly AlertRuleRecord[]> {
    const { rows } = await this.#pool.query<AlertRuleRow>(
      `SELECT * FROM alert_rules
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3
       ORDER BY created_at ASC, id ASC`,
      [validateSlug('org', ref.org), validateSlug('app', ref.app), validateSlug('env', ref.env)],
    );
    return rows.map(rowToRecord);
  }

  async getAlertRule(ref: TenantRef, id: string): Promise<AlertRuleRecord | undefined> {
    const { rows } = await this.#pool.query<AlertRuleRow>(
      `SELECT * FROM alert_rules
       WHERE id = $1 AND org_slug = $2 AND app_slug = $3 AND environment = $4`,
      [
        validateAlertRuleId(id),
        validateSlug('org', ref.org),
        validateSlug('app', ref.app),
        validateSlug('env', ref.env),
      ],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }

  async deleteAlertRule(ref: TenantRef, id: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `DELETE FROM alert_rules
       WHERE id = $1 AND org_slug = $2 AND app_slug = $3 AND environment = $4`,
      [
        validateAlertRuleId(id),
        validateSlug('org', ref.org),
        validateSlug('app', ref.app),
        validateSlug('env', ref.env),
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  async listEnabledAlertRules(): Promise<readonly AlertRuleRecord[]> {
    const { rows } = await this.#pool.query<AlertRuleRow>(
      'SELECT * FROM alert_rules WHERE enabled ORDER BY created_at ASC, id ASC',
    );
    return rows.map(rowToRecord);
  }

  async updateAlertFiringState(
    id: string,
    state: AlertFiringState,
  ): Promise<AlertRuleRecord | undefined> {
    const { rows } = await this.#pool.query<AlertRuleRow>(
      `UPDATE alert_rules
       SET breaching = $2,
           last_observed = $3,
           last_fired_at = COALESCE($4, last_fired_at)
       WHERE id = $1
       RETURNING *`,
      [validateAlertRuleId(id), state.breaching, state.lastObserved, state.lastFiredAt ?? null],
    );
    return rows[0] ? rowToRecord(rows[0]) : undefined;
  }
}

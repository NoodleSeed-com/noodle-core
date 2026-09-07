import type { Pool } from 'pg';
import { assistantAppearanceOverrideSchema } from './assistant-appearance.js';
import type {
  AssistantAppearanceReplaceResult,
  AssistantAppearanceSettingsRecord,
  AssistantAppearanceSettingsStore,
} from './assistant-appearance-store.js';
import type { TenantRef } from './tenant-ref.js';

interface AssistantAppearanceRow {
  readonly org_slug: string;
  readonly app_slug: string;
  readonly environment: string;
  readonly override_json: unknown | null;
  readonly revision: string;
  readonly updated_at: Date;
  readonly updated_by: string;
}

function toRecord(row: AssistantAppearanceRow): AssistantAppearanceSettingsRecord {
  const parsed =
    row.override_json === null
      ? undefined
      : assistantAppearanceOverrideSchema.parse(row.override_json);
  return {
    tenant: { org: row.org_slug, app: row.app_slug, env: row.environment },
    ...(parsed === undefined ? {} : { override: parsed }),
    revision: Number(row.revision),
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

/** Durable tenant/environment appearance overrides with atomic optimistic revisions. */
export class PostgresAssistantAppearanceSettingsStore implements AssistantAppearanceSettingsStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS assistant_appearance_settings (
        org_slug text NOT NULL,
        app_slug text NOT NULL,
        environment text NOT NULL,
        override_json jsonb,
        revision bigint NOT NULL,
        updated_at timestamptz NOT NULL,
        updated_by text NOT NULL,
        PRIMARY KEY (org_slug, app_slug, environment),
        CONSTRAINT assistant_appearance_revision_positive CHECK (revision > 0)
      )
    `);
  }

  async get(tenant: TenantRef): Promise<AssistantAppearanceSettingsRecord | undefined> {
    const result = await this.#pool.query<AssistantAppearanceRow>(
      `SELECT * FROM assistant_appearance_settings
       WHERE org_slug = $1 AND app_slug = $2 AND environment = $3`,
      [tenant.org, tenant.app, tenant.env],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  async replace(
    input: Parameters<AssistantAppearanceSettingsStore['replace']>[0],
  ): Promise<AssistantAppearanceReplaceResult> {
    if (input.expectedRevision === 0) {
      const inserted = await this.#pool.query<AssistantAppearanceRow>(
        `INSERT INTO assistant_appearance_settings
           (org_slug, app_slug, environment, override_json, revision, updated_at, updated_by)
         VALUES ($1, $2, $3, $4::jsonb, 1, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          input.tenant.org,
          input.tenant.app,
          input.tenant.env,
          input.override === undefined ? null : JSON.stringify(input.override),
          input.updatedAt,
          input.updatedBy,
        ],
      );
      const row = inserted.rows[0];
      if (row !== undefined) return { ok: true, record: toRecord(row) };
    } else {
      const updated = await this.#pool.query<AssistantAppearanceRow>(
        `UPDATE assistant_appearance_settings
         SET override_json = $4::jsonb,
             revision = revision + 1,
             updated_at = $5,
             updated_by = $6
         WHERE org_slug = $1 AND app_slug = $2 AND environment = $3 AND revision = $7
         RETURNING *`,
        [
          input.tenant.org,
          input.tenant.app,
          input.tenant.env,
          input.override === undefined ? null : JSON.stringify(input.override),
          input.updatedAt,
          input.updatedBy,
          input.expectedRevision,
        ],
      );
      const row = updated.rows[0];
      if (row !== undefined) return { ok: true, record: toRecord(row) };
    }

    const current = await this.get(input.tenant);
    return { ok: false, currentRevision: current?.revision ?? 0 };
  }
}

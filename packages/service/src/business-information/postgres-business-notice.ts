import { BusinessNoticeSchema } from '@noodle-borg/wire-contracts';
import type { Pool } from 'pg';
import { postgresQueryExecutor, withPostgresTransaction } from '../store/postgres-transaction.js';
import {
  BusinessNoticeError,
  type BusinessNoticeInput,
  type BusinessNoticeRecord,
  validatedNotice,
} from './business-notice.js';
import type { InstallationScope } from './contracts.js';
import { validateScope } from './validation.js';

export async function ensureBusinessNoticeSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS business_installation_notices (
    org_slug text NOT NULL, app_slug text NOT NULL, environment text NOT NULL, installation_id text NOT NULL,
    notice jsonb NOT NULL, revision bigint NOT NULL CHECK (revision>0),
    updated_at timestamptz NOT NULL, updated_by_subject text NOT NULL,
    PRIMARY KEY (org_slug,app_slug,environment,installation_id),
    FOREIGN KEY (org_slug,app_slug,environment,installation_id)
      REFERENCES business_solution_installations (org_slug,app_slug,environment,installation_id)
  )`);
}
interface NoticeRow {
  readonly notice: BusinessNoticeRecord['notice'];
  readonly revision: string;
  readonly updated_at: Date;
  readonly updated_by_subject: string;
}
const WHERE = 'org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4';
const record = (row: NoticeRow): BusinessNoticeRecord => ({
  notice: BusinessNoticeSchema.parse(row.notice),
  revision: Number(row.revision),
  updatedAt: row.updated_at.toISOString(),
  updatedBySubject: row.updated_by_subject,
});
const scopeValues = (input: InstallationScope) => {
  const scope = validateScope(input);
  return [scope.org, scope.app, scope.env, scope.installationId];
};

export async function getBusinessNoticeRow(
  pool: Pool,
  scope: InstallationScope,
): Promise<BusinessNoticeRecord | undefined> {
  const result = await postgresQueryExecutor(pool).query<NoticeRow>(
    `SELECT * FROM business_installation_notices WHERE ${WHERE}`,
    scopeValues(scope),
  );
  return result.rows[0] ? record(result.rows[0]) : undefined;
}

export async function setBusinessNoticeRow(
  pool: Pool,
  input: BusinessNoticeInput,
): Promise<BusinessNoticeRecord> {
  const notice = validatedNotice(input);
  const values = scopeValues(input.scope);
  return withPostgresTransaction(pool, async (client) => {
    // Lock the installation to serialize different administrators creating the first notice.
    await client.query(
      `SELECT installation_id FROM business_solution_installations WHERE ${WHERE} FOR UPDATE`,
      values,
    );
    const grants = await client.query<{ role: string; revoked_at: Date | null }>(
      `SELECT role,revoked_at FROM business_installation_grants WHERE ${WHERE} AND subject=$5 FOR UPDATE`,
      [...values, input.actorSubject],
    );
    if (grants.rows[0]?.role !== 'administrator' || grants.rows[0].revoked_at)
      throw new BusinessNoticeError('business_notice_forbidden');
    const current = await client.query<NoticeRow>(
      `SELECT * FROM business_installation_notices WHERE ${WHERE}`,
      values,
    );
    if (Number(current.rows[0]?.revision ?? 0) !== input.expectedRevision)
      throw new BusinessNoticeError('business_notice_conflict');
    const updated = await client.query<NoticeRow>(
      `INSERT INTO business_installation_notices
      (org_slug,app_slug,environment,installation_id,notice,revision,updated_at,updated_by_subject)
      VALUES ($1,$2,$3,$4,$5::jsonb,$6,clock_timestamp(),$7)
      ON CONFLICT (org_slug,app_slug,environment,installation_id) DO UPDATE SET
        notice=EXCLUDED.notice,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at,updated_by_subject=EXCLUDED.updated_by_subject RETURNING *`,
      [...values, JSON.stringify(notice), input.expectedRevision + 1, input.actorSubject],
    );
    if (!updated.rows[0]) throw new Error('Business notice unavailable');
    return record(updated.rows[0]);
  });
}

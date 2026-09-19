import type { Pool } from 'pg';
import { postgresQueryExecutor, withPostgresTransaction } from '../store/postgres-transaction.js';
import {
  BusinessPageError,
  type BusinessPageInput,
  type BusinessPageReadiness,
  type BusinessPageRecord,
  type BusinessPageStore,
  decodeBusinessPage,
  nextBusinessPage,
} from './business-page.js';
import { validateSealedPayload } from './cipher.js';
import type { InstallationScope, PayloadCipher } from './contracts.js';
import { getBusinessNoticeRow } from './postgres-business-notice.js';
import type { BusinessPrincipalAuthority } from './principal-authority.js';
import { validateScalar, validateScope } from './validation.js';

const where = 'org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4';
const values = (scope: InstallationScope) => [
  scope.org,
  scope.app,
  scope.env,
  scope.installationId,
];
const context = (scope: InstallationScope, revision: number) => ({
  ...scope,
  collectionKey: 'business_page',
  recordId: 'page',
  revision,
});
interface PageRow {
  readonly revision: number;
  readonly sealed_page: unknown;
}

export async function ensureBusinessPageSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS business_installation_pages (
    org_slug text NOT NULL, app_slug text NOT NULL, environment text NOT NULL, installation_id text NOT NULL,
    revision integer NOT NULL CHECK (revision>0), sealed_page jsonb NOT NULL,
    PRIMARY KEY (org_slug,app_slug,environment,installation_id),
    FOREIGN KEY (org_slug,app_slug,environment,installation_id)
      REFERENCES business_solution_installations (org_slug,app_slug,environment,installation_id)
  )`);
}

/** One bounded encrypted page per installation, using existing installation/grant transactions. */
export class PostgresBusinessPages implements BusinessPageStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: PayloadCipher,
    private readonly principals: BusinessPrincipalAuthority,
  ) {}
  async get(input: InstallationScope): Promise<BusinessPageRecord | undefined> {
    const scope = validateScope(input);
    const result = await postgresQueryExecutor(this.pool).query<PageRow>(
      `SELECT revision,sealed_page FROM business_installation_pages WHERE ${where}`,
      values(scope),
    );
    return result.rows[0] ? this.open(scope, result.rows[0]) : undefined;
  }
  private async open(scope: InstallationScope, row: PageRow): Promise<BusinessPageRecord> {
    try {
      const bytes = await this.cipher.open(
        validateSealedPayload(row.sealed_page),
        context(scope, row.revision),
      );
      return decodeBusinessPage(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
        row.revision,
      );
    } catch {
      throw new Error('Business page storage is unavailable.');
    }
  }
  async update(
    input: BusinessPageInput,
    assertReady?: BusinessPageReadiness,
  ): Promise<BusinessPageRecord> {
    const scope = validateScope(input.scope);
    const actorSubject = validateScalar('page actor', input.actorSubject, 500);
    return withPostgresTransaction(this.pool, async (client) => {
      const installation = await client.query(
        `SELECT installation_id FROM business_solution_installations WHERE ${where} FOR UPDATE`,
        values(scope),
      );
      const grants = await client.query<{ role: string; revoked_at: Date | null }>(
        `SELECT role,revoked_at FROM business_installation_grants WHERE ${where} AND subject=$5 FOR UPDATE`,
        [...values(scope), actorSubject],
      );
      if (
        !installation.rows[0] ||
        grants.rows[0]?.role !== 'administrator' ||
        grants.rows[0].revoked_at ||
        !(await this.principals.allows(actorSubject, client))
      )
        throw new BusinessPageError('business_page_forbidden');
      const current = await this.get(scope);
      const clock = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const next = await nextBusinessPage(
        current,
        { ...input, scope, actorSubject },
        clock.rows[0]!.now.toISOString(),
        await getBusinessNoticeRow(this.pool, scope),
        assertReady,
      );
      const sealed = validateSealedPayload(
        await this.cipher.seal(
          new TextEncoder().encode(JSON.stringify(next)),
          context(scope, next.revision),
        ),
      );
      await client.query(
        `INSERT INTO business_installation_pages
        (org_slug,app_slug,environment,installation_id,revision,sealed_page) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (org_slug,app_slug,environment,installation_id) DO UPDATE SET revision=EXCLUDED.revision,sealed_page=EXCLUDED.sealed_page`,
        [...values(scope), next.revision, JSON.stringify(sealed)],
      );
      return next;
    });
  }
}

import {
  type NativeRecordLifecyclePreview,
  NativeRecordLifecyclePreviewSchema,
  NativeRecordLifecycleResultSchema,
} from '@noodle-borg/wire-contracts';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
import type { InstallationScope } from './contracts.js';
import {
  checkLifecycleReview,
  LIFECYCLE_INVENTORY_LIMIT,
  lifecyclePreview,
  NativeLifecycleError,
  type NativeRecordLifecycleStore,
  sameLifecycleReview,
} from './native-record-lifecycle.js';
import { type InstallationRow, installationFromRow } from './postgres-rows.js';
import type { BusinessPrincipalAuthority } from './principal-authority.js';
import type { BusinessStaffAuthority } from './staff-authority.js';
import { validateScalar, validateScope } from './validation.js';

const WHERE = 'org_slug=$1 AND app_slug=$2 AND environment=$3 AND installation_id=$4';
/** Creation must read intake and preservation policy under the same installation lock. */
export async function lockNativeIntakePolicy(client: PoolClient, scope: InstallationScope) {
  const intake = await client.query<{
    readonly intake_active: boolean;
    readonly application_generation: string | null;
    readonly native_record_lifecycle: string | null;
  }>(
    `SELECT intake_active,application_generation,native_record_lifecycle FROM business_solution_installations WHERE ${WHERE} FOR SHARE`,
    [scope.org, scope.app, scope.env, scope.installationId],
  );
  const state = intake.rows[0];
  if (!state) throw new Error('solution installation was not found');
  return state;
}
const receiptSchema = z.strictObject({
  preview: NativeRecordLifecyclePreviewSchema,
  actor: z.string().min(1).max(256),
  result: NativeRecordLifecycleResultSchema,
});

/** Additive reader preparation only. Never migrates any installation or record on startup. */
export async function ensureNativeLifecycleSchema(pool: Pool) {
  await withPostgresTransaction(pool, async (client) => {
    await client.query(`ALTER TABLE business_solution_installations
      ADD COLUMN IF NOT EXISTS native_record_lifecycle text CHECK (native_record_lifecycle='explicit_erasure'),
      ADD COLUMN IF NOT EXISTS native_lifecycle_receipt jsonb`);
    await client.query(
      'ALTER TABLE managed_request_records ALTER COLUMN retention_expires_at DROP NOT NULL',
    );
    await client.query(`CREATE OR REPLACE FUNCTION native_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE explicit_policy boolean;
      BEGIN
        SELECT native_record_lifecycle='explicit_erasure' INTO explicit_policy
          FROM business_solution_installations WHERE
          (org_slug,app_slug,environment,installation_id)=(NEW.org_slug,NEW.app_slug,NEW.environment,NEW.installation_id);
        IF NEW.retention_expires_at IS NULL AND explicit_policy IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'Native lifecycle migration required' USING ERRCODE='23514', CONSTRAINT='native_lifecycle_required';
        END IF;
        IF explicit_policy AND NEW.retention_expires_at IS NOT NULL THEN
          IF TG_OP='INSERT' OR OLD.retention_expires_at IS NULL THEN
            RAISE EXCEPTION 'Native expiry cannot be restored' USING ERRCODE='23514', CONSTRAINT='native_lifecycle_required';
          END IF;
        END IF;
        RETURN NEW;
      END $$`);
    await client.query(`CREATE OR REPLACE TRIGGER native_record_lifecycle_guard
      BEFORE INSERT OR UPDATE ON managed_request_records FOR EACH ROW EXECUTE FUNCTION native_lifecycle_guard()`);
  });
}

interface InventoryRow {
  collection_key: string;
  record_id: string;
  revision: string;
  retention_expires_at: Date | null;
}
export class PostgresNativeRecordLifecycle implements NativeRecordLifecycleStore {
  constructor(
    private readonly pool: Pool,
    private readonly staff: BusinessStaffAuthority,
    private readonly principals: BusinessPrincipalAuthority,
    private readonly now?: () => Date,
  ) {}
  preview(scope: InstallationScope, actor: string) {
    return this.run(scope, actor);
  }
  migrate(input: {
    scope: InstallationScope;
    actor: string;
    preview: NativeRecordLifecyclePreview;
  }) {
    return this.run(input.scope, input.actor, input.preview);
  }
  private run(scope: InstallationScope, actor: string): Promise<NativeRecordLifecyclePreview>;
  private run(
    scope: InstallationScope,
    actor: string,
    preview: NativeRecordLifecyclePreview,
  ): Promise<z.infer<typeof NativeRecordLifecycleResultSchema>>;
  private run(input: InstallationScope, actor: string, preview?: NativeRecordLifecyclePreview) {
    const scope = validateScope(input);
    validateScalar('actor', actor, 256);
    const values = [scope.org, scope.app, scope.env, scope.installationId];
    return this.staff.run(
      scope,
      actor,
      'installation:administer',
      () =>
        withPostgresTransaction(this.pool, async (client) => {
          const selected = await client.query<
            InstallationRow & { native_lifecycle_receipt: unknown }
          >(`SELECT * FROM business_solution_installations WHERE ${WHERE} FOR UPDATE`, values);
          const row = selected.rows[0];
          if (!row) throw new NativeLifecycleError('lifecycle_unavailable');
          await client.query(
            `SELECT subject FROM business_installation_grants WHERE ${WHERE} AND subject=$5 FOR UPDATE`,
            [...values, actor],
          );
          if (
            !(await this.staff.allows(scope, actor, 'installation:administer')) ||
            !(await this.principals.allows(actor, client))
          )
            throw new NativeLifecycleError('lifecycle_denied');
          if (preview && row.native_lifecycle_receipt !== null) {
            const receipt = receiptSchema.parse(row.native_lifecycle_receipt);
            if (sameLifecycleReview(receipt.preview, preview) && receipt.actor === actor)
              return { ...receipt.result, replayed: true };
          }
          const inventory = await client.query<InventoryRow>(
            `SELECT collection_key,record_id,revision,retention_expires_at
        FROM managed_request_records WHERE ${WHERE} AND deleted_at IS NULL
        ORDER BY collection_key,record_id LIMIT ${LIFECYCLE_INVENTORY_LIMIT + 1} FOR UPDATE`,
            values,
          );
          const records = inventory.rows.map((r) => ({
            collectionKey: r.collection_key,
            id: r.record_id,
            revision: Number(r.revision),
            retentionExpiresAt: r.retention_expires_at?.toISOString() ?? null,
          }));
          const now =
            this.now?.().toISOString() ??
            (
              await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
            ).rows[0]?.now.toISOString();
          if (!now) throw new NativeLifecycleError('lifecycle_unavailable');
          const installation = installationFromRow(row);
          if (!preview) return lifecyclePreview(installation, records, now);
          checkLifecycleReview(installation, records, preview, now);
          const result = NativeRecordLifecycleResultSchema.parse({
            policy: 'explicit_erasure',
            installationRevision: installation.revision + 1,
            recordsPreserved: preview.recordsToPreserve,
            replayed: false,
          });
          await client.query(
            `UPDATE business_solution_installations SET native_record_lifecycle='explicit_erasure',
        native_lifecycle_receipt=$5::jsonb,revision=revision+1,updated_at=$6,updated_by_subject=$7 WHERE ${WHERE}`,
            [...values, JSON.stringify({ preview, actor, result }), now, actor],
          );
          const changed = await client.query(
            `UPDATE managed_request_records SET retention_expires_at=NULL
        WHERE ${WHERE} AND deleted_at IS NULL AND retention_expires_at>$5`,
            [...values, now],
          );
          if (changed.rowCount !== result.recordsPreserved)
            throw new NativeLifecycleError('lifecycle_conflict');
          return result;
        }),
      () => new NativeLifecycleError('lifecycle_denied'),
    );
  }
}

import type { Pool } from 'pg';
import {
  NATIVE_RETAINED_BYTES_LIMIT,
  NATIVE_TERMINAL_RESERVE_BYTES,
} from './native-storage-budget.js';
import { inTransaction } from './postgres-transaction.js';

/** Counters and triggers cover old application writers as well as current ones. No payload rewrite. */
export async function ensureNativeStorageBudget(pool: Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    // Serialize initialization and all three custody tables before the one-time backfill.
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 302330)');
    const installed =
      await client.query(`SELECT 1 FROM pg_trigger WHERE tgname='native_custody_record_guard'
      AND tgrelid='managed_request_records'::regclass AND NOT tgisinternal`);
    if (installed.rowCount !== 0) return;
    await client.query(`LOCK TABLE business_solution_installations, managed_request_records,
      managed_request_activities IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`CREATE TABLE IF NOT EXISTS native_record_custody (
      org_slug text NOT NULL, app_slug text NOT NULL, environment text NOT NULL, installation_id text NOT NULL,
      retained_bytes bigint NOT NULL CHECK (retained_bytes >= 0),
      admission_xid xid8, admission_ceiling bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (org_slug, app_slug, environment, installation_id),
      FOREIGN KEY (org_slug, app_slug, environment, installation_id)
        REFERENCES business_solution_installations(org_slug, app_slug, environment, installation_id) ON DELETE CASCADE
    )`);
    await client.query(`INSERT INTO native_record_custody (org_slug,app_slug,environment,installation_id,retained_bytes)
      SELECT i.org_slug,i.app_slug,i.environment,i.installation_id,
        COALESCE((SELECT sum(octet_length(to_jsonb(r)::text) + CASE WHEN r.deleted_at IS NULL THEN ${NATIVE_TERMINAL_RESERVE_BYTES} ELSE 0 END)
          FROM managed_request_records r WHERE (r.org_slug,r.app_slug,r.environment,r.installation_id)=
          (i.org_slug,i.app_slug,i.environment,i.installation_id)),0) +
        COALESCE((SELECT sum(octet_length(to_jsonb(a)::text)) FROM managed_request_activities a
          WHERE (a.org_slug,a.app_slug,a.environment,a.installation_id)=
          (i.org_slug,i.app_slug,i.environment,i.installation_id)),0)
      FROM business_solution_installations i
      ON CONFLICT (org_slug,app_slug,environment,installation_id) DO UPDATE SET retained_bytes=EXCLUDED.retained_bytes`);
    await client.query(`CREATE OR REPLACE FUNCTION native_custody_guard() RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
      DECLARE before_bytes bigint := 0; after_bytes bigint := 0; delta bigint; target jsonb;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          before_bytes := octet_length(to_jsonb(OLD)::text);
          IF TG_TABLE_NAME='managed_request_records' AND to_jsonb(OLD)->>'deleted_at' IS NULL THEN
            before_bytes := before_bytes + ${NATIVE_TERMINAL_RESERVE_BYTES};
          END IF;
        END IF;
        IF TG_OP <> 'DELETE' THEN
          after_bytes := octet_length(to_jsonb(NEW)::text);
          IF TG_TABLE_NAME='managed_request_records' AND to_jsonb(NEW)->>'deleted_at' IS NULL THEN
            after_bytes := after_bytes + ${NATIVE_TERMINAL_RESERVE_BYTES};
          END IF;
          target := to_jsonb(NEW);
        ELSE target := to_jsonb(OLD); END IF;
        IF TG_OP='UPDATE' AND (to_jsonb(OLD)->>'org_slug',to_jsonb(OLD)->>'app_slug',to_jsonb(OLD)->>'environment',to_jsonb(OLD)->>'installation_id') IS DISTINCT FROM
          (target->>'org_slug',target->>'app_slug',target->>'environment',target->>'installation_id') THEN
          RAISE EXCEPTION 'Native custody scope is immutable';
        END IF;
        delta := after_bytes - before_bytes;
        UPDATE native_record_custody SET retained_bytes=retained_bytes+delta,
          admission_ceiling=CASE WHEN admission_xid=pg_current_xact_id() THEN admission_ceiling
            ELSE greatest(${NATIVE_RETAINED_BYTES_LIMIT},retained_bytes) END,
          admission_xid=pg_current_xact_id()
          WHERE org_slug=target->>'org_slug' AND app_slug=target->>'app_slug'
          AND environment=target->>'environment' AND installation_id=target->>'installation_id'
          AND (delta<=0 OR retained_bytes+delta<=CASE WHEN admission_xid=pg_current_xact_id()
            THEN admission_ceiling ELSE greatest(${NATIVE_RETAINED_BYTES_LIMIT},retained_bytes) END);
        IF NOT FOUND THEN
          RAISE EXCEPTION 'Managed record storage is full' USING ERRCODE='23514', CONSTRAINT='managed_record_storage_limit';
        END IF;
        RETURN NULL;
      END $$`);
    await client.query(`CREATE OR REPLACE FUNCTION native_custody_installation() RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
      BEGIN INSERT INTO native_record_custody (org_slug,app_slug,environment,installation_id,retained_bytes) VALUES (NEW.org_slug,NEW.app_slug,NEW.environment,NEW.installation_id,0);
      RETURN NULL; END $$`);
    await client.query(`CREATE TRIGGER native_custody_installation_guard AFTER INSERT ON business_solution_installations
      FOR EACH ROW EXECUTE FUNCTION native_custody_installation()`);
    await client.query(`CREATE TRIGGER native_custody_record_guard AFTER INSERT OR UPDATE OR DELETE ON managed_request_records
      FOR EACH ROW EXECUTE FUNCTION native_custody_guard()`);
    await client.query(`CREATE TRIGGER native_custody_activity_guard AFTER INSERT OR UPDATE OR DELETE ON managed_request_activities
      FOR EACH ROW EXECUTE FUNCTION native_custody_guard()`);
  });
}

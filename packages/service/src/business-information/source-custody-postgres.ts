import type { Pool, PoolClient } from 'pg';
import { inTransaction } from './postgres-transaction.js';
import {
  SOURCE_MAX_REFRESH_KEYS,
  SOURCE_MAX_REPLICA_ROWS,
  SOURCE_METADATA_BYTES,
  SOURCE_ORG_CUSTODY_BYTES,
  SourceCapacityError,
} from './source-custody-budget.js';

export async function sourceTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  organizations: string | readonly string[] = [],
): Promise<T> {
  try {
    return await inTransaction(pool, async (client) => {
      for (const org of [
        ...new Set(typeof organizations === 'string' ? [organizations] : organizations),
      ].sort())
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtext(current_schema()),hashtext('source-custody:' || $1::text))",
          [org],
        );
      const value = await work(client);
      // Validate before returning from a joined transaction; deferred triggers also protect old writers.
      await client.query('SELECT source_custody_check_transaction()');
      return value;
    });
  } catch (error) {
    if (
      error instanceof Error &&
      'constraint' in error &&
      error.constraint === 'source_capacity_exceeded'
    )
      throw new SourceCapacityError();
    throw error;
  }
}

/** Portable counters cover every source writer; schema installation and backfill commit together. */
export async function ensureSourceCustody(pool: Pool): Promise<void> {
  await inTransaction(pool, async (client) => {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext(current_schema()), 302344)');
    const installed = await client.query(`SELECT 1 FROM pg_trigger
      WHERE tgname='source_custody_binding_guard' AND tgrelid='business_source_bindings'::regclass AND NOT tgisinternal`);
    if (installed.rowCount !== 0) return;
    await client.query(`LOCK TABLE business_source_bindings,business_external_records,
      business_source_suppressions,business_source_refresh_requests IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`UPDATE business_source_refresh_requests r SET target_scan_generation=greatest(1,b.scan_generation+
      CASE WHEN r.state='queued' THEN 1 ELSE 0 END) FROM business_source_bindings b WHERE
      (r.org_slug,r.app_slug,r.environment,r.installation_id,r.collection_key,r.binding_id,r.binding_generation)=
      (b.org_slug,b.app_slug,b.environment,b.installation_id,b.collection_key,b.binding_id,b.binding_generation)`);
    await client.query(`CREATE TABLE source_custody_organizations (
      org_slug text PRIMARY KEY, charged_bytes bigint NOT NULL CHECK(charged_bytes>=0),
      admission_xid xid8, admission_ceiling bigint NOT NULL DEFAULT ${SOURCE_ORG_CUSTODY_BYTES}
    ); CREATE TABLE source_custody_installations (
      org_slug text NOT NULL,app_slug text NOT NULL,environment text NOT NULL,installation_id text NOT NULL,
      replica_rows bigint NOT NULL DEFAULT 0 CHECK(replica_rows>=0),
      row_units bigint NOT NULL DEFAULT 0 CHECK(row_units>=0),
      refresh_keys bigint NOT NULL DEFAULT 0 CHECK(refresh_keys>=0), admission_xid xid8,
      rows_ceiling bigint NOT NULL DEFAULT ${SOURCE_MAX_REPLICA_ROWS},
      units_ceiling bigint NOT NULL DEFAULT ${2 * SOURCE_MAX_REPLICA_ROWS},
      refresh_ceiling bigint NOT NULL DEFAULT ${SOURCE_MAX_REFRESH_KEYS},
      PRIMARY KEY(org_slug,app_slug,environment,installation_id)
    ); CREATE TABLE source_custody_bindings (
      org_slug text NOT NULL,app_slug text NOT NULL,environment text NOT NULL,installation_id text NOT NULL,
      collection_key text NOT NULL,binding_id text NOT NULL,
      retained_bytes bigint NOT NULL DEFAULT 0 CHECK(retained_bytes>=0),
      projected_bytes bigint NOT NULL DEFAULT 0 CHECK(projected_bytes>=0),
      baseline_bytes bigint, snapshot_generation bigint,
      PRIMARY KEY(org_slug,app_slug,environment,installation_id,collection_key,binding_id)
    )`);
    await client.query(`CREATE INDEX source_custody_organization_xid_idx ON source_custody_organizations(admission_xid);
      CREATE INDEX source_custody_installation_xid_idx ON source_custody_installations(admission_xid)`);
    await client.query(`CREATE FUNCTION source_custody_cost(kind text, value jsonb) RETURNS bigint
      LANGUAGE plpgsql IMMUTABLE AS $$
      DECLARE payload jsonb; metadata jsonb; amount bigint := ${SOURCE_METADATA_BYTES};
      BEGIN
        IF value IS NULL THEN RETURN 0; END IF;
        payload := value->'content_ciphertext';
        metadata := value-'content_ciphertext';
        IF octet_length(metadata::text)>${SOURCE_METADATA_BYTES} THEN
          RAISE EXCEPTION 'Source metadata exceeds reserved representation';
        END IF;
        IF kind='business_source_bindings' THEN amount:=amount+${SOURCE_METADATA_BYTES}; END IF;
        IF payload IS NOT NULL AND payload<>'null'::jsonb THEN amount:=amount+octet_length(payload::text); END IF;
        IF kind='business_external_records' AND value->>'deleted_at' IS NULL THEN
          amount:=amount+${SOURCE_METADATA_BYTES};
        END IF;
        RETURN amount;
      END $$;
      CREATE FUNCTION source_custody_charge(retained bigint,baseline bigint,projected bigint) RETURNS bigint
      LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN baseline IS NULL THEN 2*retained
        ELSE greatest(retained,2*greatest(baseline,projected)) END $$;
      CREATE FUNCTION source_custody_projected(kind text,value jsonb,generation bigint) RETURNS bigint
      LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN value IS NULL THEN 0
        WHEN kind='business_external_records' AND generation IS NOT NULL AND value->>'deleted_at' IS NULL
          AND (value->>'last_seen_generation')::bigint<>generation THEN ${SOURCE_METADATA_BYTES}
        ELSE source_custody_cost(kind,value) END $$`);
    await client.query(`INSERT INTO source_custody_bindings
      SELECT b.org_slug,b.app_slug,b.environment,b.installation_id,b.collection_key,b.binding_id,
        source_custody_cost('business_source_bindings',to_jsonb(b))+
          COALESCE((SELECT sum(source_custody_cost('business_external_records',to_jsonb(r))) FROM business_external_records r
            WHERE (r.org_slug,r.app_slug,r.environment,r.installation_id,r.collection_key,r.binding_id)=
              (b.org_slug,b.app_slug,b.environment,b.installation_id,b.collection_key,b.binding_id)),0)+
          ${SOURCE_METADATA_BYTES}*(SELECT count(*) FROM business_source_suppressions s WHERE
            (s.org_slug,s.app_slug,s.environment,s.installation_id,s.collection_key,s.binding_id)=
              (b.org_slug,b.app_slug,b.environment,b.installation_id,b.collection_key,b.binding_id)),0,NULL,NULL
      FROM business_source_bindings b;
      UPDATE source_custody_bindings SET projected_bytes=retained_bytes;
      INSERT INTO source_custody_organizations(org_slug,charged_bytes)
      SELECT org_slug,${SOURCE_METADATA_BYTES}+sum(bytes) FROM (
        SELECT org_slug,2*retained_bytes AS bytes FROM source_custody_bindings
        UNION ALL SELECT org_slug,${SOURCE_METADATA_BYTES} FROM business_source_refresh_requests
      ) usage GROUP BY org_slug;
      INSERT INTO source_custody_installations(org_slug,app_slug,environment,installation_id,replica_rows,row_units,refresh_keys)
      SELECT org_slug,app_slug,environment,installation_id,sum(rows),sum(units),sum(refresh) FROM (
        SELECT org_slug,app_slug,environment,installation_id,0 AS rows,0 AS units,0 AS refresh FROM business_source_bindings
        UNION ALL SELECT org_slug,app_slug,environment,installation_id,1,
          CASE WHEN deleted_at IS NULL THEN 2 ELSE 1 END,0 FROM business_external_records
        UNION ALL SELECT org_slug,app_slug,environment,installation_id,0,1,0 FROM business_source_suppressions
        UNION ALL SELECT org_slug,app_slug,environment,installation_id,0,0,1 FROM business_source_refresh_requests
      ) usage GROUP BY org_slug,app_slug,environment,installation_id`);
    await client.query(`CREATE FUNCTION source_custody_check_transaction() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM source_custody_organizations WHERE admission_xid=pg_current_xact_id()
          AND charged_bytes>admission_ceiling) OR
          EXISTS(SELECT 1 FROM source_custody_installations WHERE admission_xid=pg_current_xact_id() AND
            (replica_rows>rows_ceiling OR row_units>units_ceiling OR refresh_keys>refresh_ceiling)) THEN
          RAISE EXCEPTION 'Reference storage is full' USING ERRCODE='23514',CONSTRAINT='source_capacity_exceeded';
        END IF;
      END $$;
      CREATE FUNCTION source_custody_deferred_check() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM source_custody_check_transaction(); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER source_custody_organization_check AFTER INSERT OR UPDATE ON source_custody_organizations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION source_custody_deferred_check();
      CREATE CONSTRAINT TRIGGER source_custody_installation_check AFTER INSERT OR UPDATE ON source_custody_installations
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION source_custody_deferred_check()`);
    await client.query(`CREATE FUNCTION source_custody_guard() RETURNS trigger LANGUAGE plpgsql SET timezone='UTC' AS $$
      DECLARE target jsonb; previous jsonb; following jsonb;
        usage source_custody_bindings%ROWTYPE; before_charge bigint; after_charge bigint;
        delta bigint; rows_delta bigint:=0; units_delta bigint:=0; refresh_delta bigint:=0;
      BEGIN
        IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
        IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW); END IF;
        target:=COALESCE(following,previous);
        IF TG_OP='UPDATE' AND (previous->>'org_slug',previous->>'app_slug',previous->>'environment',previous->>'installation_id',previous->>'collection_key',previous->>'binding_id') IS DISTINCT FROM
          (following->>'org_slug',following->>'app_slug',following->>'environment',following->>'installation_id',following->>'collection_key',following->>'binding_id') THEN
          RAISE EXCEPTION 'Source custody scope is immutable';
        END IF;
        INSERT INTO source_custody_organizations(org_slug,charged_bytes)
          VALUES(target->>'org_slug',${SOURCE_METADATA_BYTES}) ON CONFLICT DO NOTHING;
        PERFORM 1 FROM source_custody_organizations WHERE org_slug=target->>'org_slug' FOR UPDATE;
        INSERT INTO source_custody_installations(org_slug,app_slug,environment,installation_id)
          VALUES(target->>'org_slug',target->>'app_slug',target->>'environment',target->>'installation_id') ON CONFLICT DO NOTHING;
        IF TG_TABLE_NAME='business_source_refresh_requests' THEN
          delta:=source_custody_cost(TG_TABLE_NAME,following)-source_custody_cost(TG_TABLE_NAME,previous);
          refresh_delta:=CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
        ELSE
          INSERT INTO source_custody_bindings(org_slug,app_slug,environment,installation_id,collection_key,binding_id)
            VALUES(target->>'org_slug',target->>'app_slug',target->>'environment',target->>'installation_id',target->>'collection_key',target->>'binding_id') ON CONFLICT DO NOTHING;
          SELECT * INTO STRICT usage FROM source_custody_bindings WHERE
            (org_slug,app_slug,environment,installation_id,collection_key,binding_id)=
            (target->>'org_slug',target->>'app_slug',target->>'environment',target->>'installation_id',target->>'collection_key',target->>'binding_id') FOR UPDATE;
          before_charge:=source_custody_charge(usage.retained_bytes,usage.baseline_bytes,usage.projected_bytes);
          usage.retained_bytes:=usage.retained_bytes+source_custody_cost(TG_TABLE_NAME,following)-source_custody_cost(TG_TABLE_NAME,previous);
          usage.projected_bytes:=usage.projected_bytes+source_custody_projected(TG_TABLE_NAME,following,usage.snapshot_generation)-source_custody_projected(TG_TABLE_NAME,previous,usage.snapshot_generation);
          IF TG_TABLE_NAME='business_source_bindings' THEN
            IF following->>'scan_mode'='snapshot' AND (usage.snapshot_generation IS DISTINCT FROM (following->>'scan_generation')::bigint) THEN
              usage.baseline_bytes:=usage.retained_bytes;
              usage.snapshot_generation:=(following->>'scan_generation')::bigint;
              SELECT usage.retained_bytes+COALESCE(sum(source_custody_projected('business_external_records',to_jsonb(r),usage.snapshot_generation)-
                source_custody_cost('business_external_records',to_jsonb(r))),0) INTO usage.projected_bytes FROM business_external_records r WHERE
                (r.org_slug,r.app_slug,r.environment,r.installation_id,r.collection_key,r.binding_id)=
                (usage.org_slug,usage.app_slug,usage.environment,usage.installation_id,usage.collection_key,usage.binding_id);
            ELSIF following->>'scan_mode' IS DISTINCT FROM 'snapshot' THEN
              usage.baseline_bytes:=NULL; usage.snapshot_generation:=NULL; usage.projected_bytes:=usage.retained_bytes;
            END IF;
          END IF;
          UPDATE source_custody_bindings SET retained_bytes=usage.retained_bytes,projected_bytes=usage.projected_bytes,
            baseline_bytes=usage.baseline_bytes,snapshot_generation=usage.snapshot_generation WHERE
            (org_slug,app_slug,environment,installation_id,collection_key,binding_id)=
            (usage.org_slug,usage.app_slug,usage.environment,usage.installation_id,usage.collection_key,usage.binding_id);
          after_charge:=source_custody_charge(usage.retained_bytes,usage.baseline_bytes,usage.projected_bytes);
          delta:=after_charge-before_charge;
          IF TG_TABLE_NAME='business_external_records' THEN
            rows_delta:=CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
            units_delta:=rows_delta+CASE WHEN following IS NOT NULL AND following->>'deleted_at' IS NULL THEN 1 ELSE 0 END-
              CASE WHEN previous IS NOT NULL AND previous->>'deleted_at' IS NULL THEN 1 ELSE 0 END;
          ELSIF TG_TABLE_NAME='business_source_suppressions' THEN
            units_delta:=CASE TG_OP WHEN 'INSERT' THEN 1 WHEN 'DELETE' THEN -1 ELSE 0 END;
          END IF;
        END IF;
        UPDATE source_custody_organizations SET charged_bytes=charged_bytes+delta,
          admission_ceiling=CASE WHEN admission_xid=pg_current_xact_id() THEN admission_ceiling ELSE greatest(${SOURCE_ORG_CUSTODY_BYTES},charged_bytes) END,
          admission_xid=pg_current_xact_id() WHERE org_slug=target->>'org_slug';
        UPDATE source_custody_installations SET replica_rows=replica_rows+rows_delta,row_units=row_units+units_delta,refresh_keys=refresh_keys+refresh_delta,
          rows_ceiling=CASE WHEN admission_xid=pg_current_xact_id() THEN rows_ceiling ELSE greatest(${SOURCE_MAX_REPLICA_ROWS},replica_rows) END,
          units_ceiling=CASE WHEN admission_xid=pg_current_xact_id() THEN units_ceiling ELSE greatest(${2 * SOURCE_MAX_REPLICA_ROWS},row_units) END,
          refresh_ceiling=CASE WHEN admission_xid=pg_current_xact_id() THEN refresh_ceiling ELSE greatest(${SOURCE_MAX_REFRESH_KEYS},refresh_keys) END,
          admission_xid=pg_current_xact_id() WHERE (org_slug,app_slug,environment,installation_id)=
            (target->>'org_slug',target->>'app_slug',target->>'environment',target->>'installation_id');
        RETURN NULL;
      END $$`);
    for (const [table, suffix] of [
      ['business_source_bindings', 'binding'],
      ['business_external_records', 'record'],
      ['business_source_suppressions', 'suppression'],
      ['business_source_refresh_requests', 'refresh'],
    ])
      await client.query(`CREATE TRIGGER source_custody_${suffix}_guard AFTER INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION source_custody_guard()`);
  });
}

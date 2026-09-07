import type { Pool } from 'pg';
import { MAX_RETAINED_INSTALLATIONS_PER_ORG } from './installation-capacity.js';

/** The database guard also covers compatible older writers during a rolling release. */
export async function ensureInstallationCapacity(pool: Pool): Promise<void> {
  await pool.query(`CREATE OR REPLACE FUNCTION business_check_installation_capacity()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('business-installations:' || NEW.org_slug, 0));
      IF EXISTS (SELECT 1 FROM business_solution_installations
        WHERE (org_slug=NEW.org_slug AND installation_id=NEW.installation_id)
          OR public_id=NEW.public_id) THEN
        RETURN NEW;
      END IF;
      IF (SELECT count(*) FROM business_solution_installations WHERE org_slug=NEW.org_slug)
          >= ${MAX_RETAINED_INSTALLATIONS_PER_ORG} THEN
        RAISE EXCEPTION 'Retained installation capacity reached'
          USING ERRCODE='23514', CONSTRAINT='business_installation_capacity';
      END IF;
      RETURN NEW;
    END $$`);
  await pool.query(`CREATE OR REPLACE TRIGGER business_installation_capacity_guard
    BEFORE INSERT ON business_solution_installations
    FOR EACH ROW EXECUTE FUNCTION business_check_installation_capacity()`);
}

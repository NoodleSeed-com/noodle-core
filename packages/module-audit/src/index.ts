import { MODULE_API_VERSION, type ServiceModule } from '@noodle-borg/module';
import type { Pool } from 'pg';
import { PostgresAuditStore } from './postgres-audit.js';
import { createAuditEventsRoute } from './route.js';

export type {
  PostgresAuditInsertOptions,
  PostgresAuditQueryable,
} from './postgres-audit.js';
export { ensureAuditSchema, insertAuditEvent, PostgresAuditStore } from './postgres-audit.js';
export { createAuditEventsRoute } from './route.js';

export function createModule(): ServiceModule {
  return {
    name: '@noodle-borg/module-audit',
    version: '0.0.0',
    apiVersion: MODULE_API_VERSION,
    init: async (ctx) => {
      const pool = ctx.stores?.postgresPool?.();
      if (!isPgPool(pool)) {
        throw new Error('@noodle-borg/module-audit requires a Postgres pool');
      }
      const store = new PostgresAuditStore(pool);
      await store.ensureSchema();
      return {
        auditStore: store,
        routes: [createAuditEventsRoute(store)],
        readiness: async () => {
          try {
            await pool.query('SELECT 1');
            return true;
          } catch {
            return false;
          }
        },
      };
    },
  };
}

function isPgPool(value: unknown): value is Pool {
  return typeof value === 'object' && value !== null && typeof (value as Pool).query === 'function';
}

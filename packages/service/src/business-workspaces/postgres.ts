import type { Pool } from 'pg';
import { validateSealedPayload } from '../business-information/cipher.js';
import type { PayloadCipher, PayloadCipherContext } from '../business-information/contracts.js';
import { postgresQueryExecutor, withPostgresTransaction } from '../store/postgres-transaction.js';
import {
  type BusinessWorkspaceBackend,
  type BusinessWorkspaceTransaction,
  type WorkspaceState,
  WorkspaceStateSchema,
} from './contracts.js';

interface Row {
  readonly revision: number;
  readonly sealed_state: unknown;
}
// Bounded 1,000 members / 100 invitations, including worst-case escaped subjects.
const maximumSealedAuthority = 16 * 1024 * 1024;

/** One encrypted, versioned authority per existing organization, with atomic membership audit. */
export class PostgresBusinessWorkspaceBackend implements BusinessWorkspaceBackend {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: PayloadCipher,
  ) {}
  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS business_workspace_authority (
        org TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        sealed_state JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS business_workspace_authority_events (
        org TEXT NOT NULL REFERENCES business_workspace_authority(org),
        revision INTEGER NOT NULL,
        event JSONB NOT NULL,
        PRIMARY KEY (org, revision)
      );
    `);
  }
  async read(org: string): Promise<WorkspaceState | undefined> {
    const result = await postgresQueryExecutor(this.pool).query<Row>(
      'SELECT revision, sealed_state FROM business_workspace_authority WHERE org = $1',
      [org],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    try {
      const bytes = await this.cipher.open(
        validateSealedPayload(row.sealed_state, maximumSealedAuthority),
        context(org, row.revision),
      );
      const state = WorkspaceStateSchema.parse(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      );
      if (state.org !== org || state.revision !== row.revision) throw new Error('scope');
      return state;
    } catch {
      throw new Error('workspace authority unavailable');
    }
  }
  run<T>(org: string, work: (tx: BusinessWorkspaceTransaction) => Promise<T>): Promise<T> {
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `business-workspace:${org}`,
      ]);
      const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = time.rows[0]?.now;
      if (!now) throw new Error('workspace transaction clock unavailable');
      return work({
        now: now.toISOString(),
        get: () => this.read(org),
        save: async (value, event) => {
          const state = WorkspaceStateSchema.parse(value);
          if (state.org !== org || event.revision !== state.revision)
            throw new Error('workspace authority conflict');
          const sealed = validateSealedPayload(
            await this.cipher.seal(
              new TextEncoder().encode(JSON.stringify(state)),
              context(org, state.revision),
            ),
            maximumSealedAuthority,
          );
          const result =
            state.revision === 1
              ? await client.query(
                  `INSERT INTO business_workspace_authority (org, revision, sealed_state)
               VALUES ($1, 1, $2::jsonb) ON CONFLICT DO NOTHING RETURNING org`,
                  [org, JSON.stringify(sealed)],
                )
              : await client.query(
                  `UPDATE business_workspace_authority SET revision = $2, sealed_state = $3::jsonb
               WHERE org = $1 AND revision = $2 - 1 RETURNING org`,
                  [org, state.revision, JSON.stringify(sealed)],
                );
          if (result.rowCount !== 1) throw new Error('workspace authority conflict');
          await client.query(
            `INSERT INTO business_workspace_authority_events (org, revision, event)
             VALUES ($1, $2, $3::jsonb)`,
            [org, state.revision, JSON.stringify(event)],
          );
        },
      });
    });
  }
}

function context(org: string, revision: number): PayloadCipherContext {
  return {
    org,
    app: 'business-workspace',
    env: 'authority',
    installationId: `workspace:${org}`,
    collectionKey: 'staff',
    recordId: org,
    revision,
  };
}

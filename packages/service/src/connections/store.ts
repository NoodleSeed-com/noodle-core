import { createHash } from 'node:crypto';
import type { SealedSecret, SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
import type {
  ConnectionKey,
  ConnectionStore,
  ConnectionTransaction,
  StoredConnection,
} from './types.js';
import {
  connectionScopeSchema,
  parseConnectionEnvelope,
  parseStoredConnection,
} from './validation.js';

export function connectionKey(key: ConnectionKey): string {
  return createHash('sha256')
    .update(JSON.stringify([key.org, key.app, key.env, key.installationId, key.connectionId]))
    .digest('hex');
}
/** Local/test transactions preserve the same copy-on-commit and single-connection serialization. */
export class InMemoryConnectionStore implements ConnectionStore {
  readonly #records = new Map<string, StoredConnection>();
  readonly #states = new Map<string, { key: ConnectionKey; expiresAt: number }>();
  readonly #locks = new Map<string, Promise<void>>();
  async transact<T>(
    key: ConnectionKey,
    work: (transaction: ConnectionTransaction) => Promise<T>,
  ): Promise<T> {
    const id = connectionKey(key);
    const previous = this.#locks.get(id) ?? Promise.resolve();
    let release = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(id, pending);
    await previous;
    let value = this.#records.get(id);
    try {
      const result = await work({
        read: async () => (value === undefined ? undefined : structuredClone(value)),
        write: async (next) => {
          value = parseStoredConnection(next);
        },
      });
      if (value !== undefined) this.#records.set(id, value);
      return result;
    } finally {
      release();
      if (this.#locks.get(id) === pending) this.#locks.delete(id);
    }
  }
  async putState(hash: string, key: ConnectionKey, expiresAt: number) {
    for (const [id, state] of this.#states)
      if (state.expiresAt <= Date.now()) this.#states.delete(id);
    this.#states.set(hash, { key: structuredClone(key), expiresAt });
  }
  async getState(hash: string, now: number) {
    const state = this.#states.get(hash);
    return state !== undefined && state.expiresAt > now ? structuredClone(state.key) : undefined;
  }
  async deleteState(hash: string) {
    this.#states.delete(hash);
  }
}

/** Existing PostgreSQL and SecretBox custody; a scope-bound sealed record is the sole account authority. */
export class PostgresConnectionStore implements ConnectionStore {
  constructor(
    readonly pool: Pool,
    readonly secretBox: SecretBox,
  ) {
    if (secretBox === undefined)
      throw new Error('Connections require configured secret encryption');
  }
  async ensureSchema(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS external_connections (connection_key text PRIMARY KEY, sealed_record jsonb);
      CREATE TABLE IF NOT EXISTS external_connection_states (state_hash text PRIMARY KEY, scope jsonb NOT NULL, expires_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS external_connection_states_expiry ON external_connection_states(expires_at)`);
  }
  async transact<T>(
    key: ConnectionKey,
    work: (transaction: ConnectionTransaction) => Promise<T>,
  ): Promise<T> {
    const id = connectionKey(key);
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(
        'INSERT INTO external_connections(connection_key) VALUES ($1) ON CONFLICT DO NOTHING',
        [id],
      );
      const { rows } = await client.query<{ sealed_record: SealedSecret | null }>(
        'SELECT sealed_record FROM external_connections WHERE connection_key=$1 FOR UPDATE',
        [id],
      );
      const sealed = rows[0]?.sealed_record;
      let value: StoredConnection | undefined;
      if (sealed !== null && sealed !== undefined) {
        value = parseConnectionEnvelope(JSON.parse(await this.secretBox.open(sealed)), id);
      }
      const result = await work({
        read: async () => (value === undefined ? undefined : structuredClone(value)),
        write: async (next) => {
          const envelope = await this.secretBox.seal(
            JSON.stringify({ key: id, value: parseStoredConnection(next) }),
          );
          await client.query(
            'UPDATE external_connections SET sealed_record=$2::jsonb WHERE connection_key=$1',
            [id, JSON.stringify(envelope)],
          );
          value = parseStoredConnection(next);
        },
      });
      return result;
    });
  }
  async putState(hash: string, key: ConnectionKey, expiresAt: number): Promise<void> {
    await this.pool.query('DELETE FROM external_connection_states WHERE expires_at <= now()');
    await this.pool.query(
      'INSERT INTO external_connection_states(state_hash,scope,expires_at) VALUES ($1,$2::jsonb,$3)',
      [hash, JSON.stringify(key), new Date(expiresAt)],
    );
  }
  async getState(hash: string, now: number): Promise<ConnectionKey | undefined> {
    const { rows } = await this.pool.query<{ scope: ConnectionKey }>(
      'SELECT scope FROM external_connection_states WHERE state_hash=$1 AND expires_at>$2',
      [hash, new Date(now)],
    );
    return rows[0] === undefined ? undefined : connectionScopeSchema.parse(rows[0].scope);
  }
  async deleteState(hash: string): Promise<void> {
    await this.pool.query('DELETE FROM external_connection_states WHERE state_hash=$1', [hash]);
  }
}

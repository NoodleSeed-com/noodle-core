import type { ArtifactState } from '@noodle-borg/compiler';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptCallerState,
  ensureStateHandleSchema,
  PostgresStateHandleStore,
} from '../src/postgres.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `state_adoption_test_${process.pid}`;
const NOW = new Date('2026-09-01T12:00:00.000Z');

const STATE: ArtifactState = {
  handles: {
    draft: {
      kind: 'draft',
      version: 'v1',
      scope: 'caller',
      ttlSeconds: 3_600,
      claimOnAuthentication: true,
      schema: { type: 'object', properties: { title: { type: 'string' } } },
    },
    selection: {
      kind: 'selection',
      version: 'v1',
      scope: 'caller',
      ttlSeconds: 3_600,
      schema: { type: 'object', properties: { item: { type: 'string' } } },
    },
  },
};

describe.skipIf(!URL)('PostgreSQL caller-state adoption', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL, max: 1 });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({ connectionString: URL, max: 4, options: `-c search_path=${SCHEMA}` });
    await ensureStateHandleSchema(pool);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE state_handle_owner_redirects, state_handle_records');
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  it('rekeys opted state without changing its lifecycle metadata and redirects late writes', async () => {
    let clock = NOW;
    const store = new PostgresStateHandleStore(pool, {
      deploymentId: 'deploy_1',
      state: STATE,
      now: () => clock,
    });
    await store.patch({
      handle: 'draft',
      callerSubject: 'anonymous-session',
      expectedRevision: 0,
      value: { title: 'Blueprint' },
    });
    await store.patch({
      handle: 'selection',
      callerSubject: 'anonymous-session',
      expectedRevision: 0,
      value: { item: 'private' },
    });
    const before = await persisted('draft', 'anonymous-session');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const adopted = await adoptCallerState(client, {
        deploymentId: 'deploy_1',
        handles: ['draft'],
        sourceCallerSubject: 'anonymous-session',
        targetCallerSubject: 'account-42',
        redirectExpiresAt: new Date('2026-09-01T12:10:00.000Z'),
        now: NOW,
      });
      expect(adopted).toEqual({ ok: true, adoptedHandles: ['draft'], adoptedRecords: 1 });
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const after = await persisted('draft', 'account-42');
    expect(after).toEqual(before);
    await expect(
      store.read({ handle: 'draft', callerSubject: 'account-42' }),
    ).resolves.toMatchObject({
      value: { title: 'Blueprint' },
      revision: 1,
    });
    await expect(
      store.patch({
        handle: 'draft',
        callerSubject: 'anonymous-session',
        expectedRevision: 1,
        value: { title: 'Late but safe' },
      }),
    ).resolves.toMatchObject({ value: { title: 'Late but safe' }, revision: 2 });
    await expect(
      store.read({ handle: 'draft', callerSubject: 'account-42' }),
    ).resolves.toMatchObject({
      value: { title: 'Late but safe' },
      revision: 2,
    });
    await expect(
      store.read({ handle: 'selection', callerSubject: 'account-42' }),
    ).resolves.toMatchObject({ value: {}, revision: 0 });

    // A request admitted just before absolute expiry may reach state after expiry. The redirect
    // remains a bounded fence for that execution window, but creates no new session authority.
    clock = new Date('2026-09-01T12:11:00.000Z');
    await expect(
      store.patch({
        handle: 'draft',
        callerSubject: 'anonymous-session',
        expectedRevision: 2,
        value: { title: 'In-flight and fenced' },
      }),
    ).resolves.toMatchObject({ value: { title: 'In-flight and fenced' }, revision: 3 });
    clock = new Date('2026-09-01T12:16:00.000Z');
    await expect(
      store.read({ handle: 'draft', callerSubject: 'anonymous-session' }),
    ).resolves.toMatchObject({ value: {}, revision: 0 });
  });

  it('reports an exact destination-key collision without moving either owner', async () => {
    const store = new PostgresStateHandleStore(pool, {
      deploymentId: 'deploy_1',
      state: STATE,
      now: () => NOW,
    });
    await store.patch({
      handle: 'draft',
      callerSubject: 'anonymous-session',
      expectedRevision: 0,
      value: { title: 'Anonymous' },
    });
    await store.patch({
      handle: 'draft',
      callerSubject: 'account-42',
      expectedRevision: 0,
      value: { title: 'Authenticated' },
    });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const adopted = await adoptCallerState(client, {
        deploymentId: 'deploy_1',
        handles: ['draft'],
        sourceCallerSubject: 'anonymous-session',
        targetCallerSubject: 'account-42',
        redirectExpiresAt: new Date('2026-09-01T13:00:00.000Z'),
        now: NOW,
      });
      expect(adopted).toEqual({ ok: false, reason: 'state_key_conflict' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await expect(
      store.read({ handle: 'draft', callerSubject: 'anonymous-session' }),
    ).resolves.toMatchObject({
      value: { title: 'Anonymous' },
    });
    await expect(
      store.read({ handle: 'draft', callerSubject: 'account-42' }),
    ).resolves.toMatchObject({
      value: { title: 'Authenticated' },
    });
  });

  async function persisted(handle: string, owner: string): Promise<Record<string, unknown>> {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT handle_version, value, revision, status, created_at, updated_at, expires_at
       FROM state_handle_records
       WHERE deployment_id = 'deploy_1' AND handle_name = $1 AND owner_key = $2 AND state_key = 'default'`,
      [handle, owner],
    );
    const row = result.rows[0];
    if (!row) throw new Error('expected persisted state record');
    return row;
  }
});

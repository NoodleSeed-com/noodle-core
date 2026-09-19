import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import { APPLICATION_DRAFT_LIMITS } from '@noodle-borg/wire-contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresApplicationDraftBackend } from '../src/application-drafts/postgres.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';
import { postgresQueryExecutor } from '../src/store/postgres-transaction.js';
import { describeApplicationDraftStore } from './application-drafts-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL application drafts', () => {
  const schema = `application_drafts_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  // One connection proves that authorization and persistence join the same transaction.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 3000,
  });
  const cipher = new SecretBoxPayloadCipher(
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 7).toString('base64'))),
  );
  const backend = new PostgresApplicationDraftBackend(pool, cipher);
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await backend.ensureSchema();
    await backend.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  describeApplicationDraftStore(async () => {
    let active = true;
    return {
      store: new ApplicationDraftStore(backend, {
        authorize: async (_scope, actor) => {
          await postgresQueryExecutor(pool).query('SELECT 1');
          return active && actor === 'builder';
        },
      }),
      revoke: () => {
        active = false;
      },
    };
  });

  const source = {
    entrypoint: 'server.ts',
    files: [{ path: 'server.ts', content: '// private-customer-source\nexport default {};' }],
  };
  const command = () => ({
    scope: { org: `org-${randomUUID()}`, app: 'assistant' },
    actorSubject: 'builder',
    idempotencyKey: randomUUID(),
    environment: 'prod',
    source,
  });
  const options = { authorize: async () => true };

  it('stores the full allowed source even at worst-case JSON escape expansion', async () => {
    const store = new ApplicationDraftStore(backend, options);
    const input = command();
    const escaped = {
      entrypoint: 'server.ts',
      files: Array.from({ length: 4 }, (_, i) => ({
        path: i === 0 ? 'server.ts' : `part-${i}.ts`,
        content: '\u0000'.repeat(APPLICATION_DRAFT_LIMITS.fileBytes),
      })),
    };
    const draft = await store.create({ ...input, source: escaped });
    expect((await store.get(input.scope, draft.id, 'builder')).sourceDigest).toBe(
      draft.sourceDigest,
    );
  });

  it('retains erased-source retry protection until the fixed 24-hour window expires', async () => {
    const store = new ApplicationDraftStore(backend, options);
    const input = command();
    const draft = await store.create(input);
    await store.remove({ ...input, id: draft.id, expectedRevision: 1 });
    await expect(store.create(input)).rejects.toMatchObject({ code: 'draft_deleted' });
    await pool.query(
      "UPDATE application_draft_receipts SET expires_at = clock_timestamp() - interval '1 millisecond' WHERE org = $1",
      [input.scope.org],
    );
    expect((await store.create(input)).id).not.toBe(draft.id);
    expect(
      (
        await pool.query('SELECT * FROM application_draft_receipts WHERE org = $1', [
          input.scope.org,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it('recovers exact source and retry evidence in a fresh store with no plaintext source at rest', async () => {
    const store = new ApplicationDraftStore(backend, options);
    const input = command();
    const draft = await store.create(input);
    const rows = await pool.query('SELECT * FROM application_draft_revisions WHERE org = $1', [
      input.scope.org,
    ]);
    expect(JSON.stringify(rows.rows)).not.toContain('private-customer-source');
    const restarted = new ApplicationDraftStore(
      new PostgresApplicationDraftBackend(pool, cipher),
      options,
    );
    expect(await restarted.get(input.scope, draft.id, 'builder')).toEqual(draft);
    expect(await restarted.create(input)).toEqual(draft);
  });

  it('refuses ciphertext copied from another draft and redacts the failure', async () => {
    const store = new ApplicationDraftStore(backend, options);
    const input = command();
    const first = await store.create(input);
    const second = await store.create({ ...input, idempotencyKey: randomUUID() });
    await pool.query(
      `UPDATE application_draft_revisions target SET sealed_source = source.sealed_source
       FROM application_draft_revisions source
       WHERE target.org = $1 AND target.draft_id = $2 AND source.org = $1 AND source.draft_id = $3`,
      [input.scope.org, second.id, first.id],
    );
    await expect(store.get(input.scope, second.id, 'builder')).rejects.toThrow(
      'draft revision unavailable',
    );
    expect(await store.get(input.scope, first.id, 'builder')).toEqual(first);
  });

  it('rolls back a failed revision without leaving an idempotency receipt', async () => {
    let fail = false;
    const guarded = new PostgresApplicationDraftBackend(pool, {
      seal: async (bytes, context) => {
        if (fail) throw new Error('test cipher unavailable');
        return cipher.seal(bytes, context);
      },
      open: (payload, context) => cipher.open(payload, context),
    });
    const store = new ApplicationDraftStore(guarded, options);
    const input = command();
    const draft = await store.create(input);
    const edit = {
      ...input,
      id: draft.id,
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
      source: { ...source, files: [{ path: 'server.ts', content: 'changed' }] },
    };
    fail = true;
    await expect(store.edit(edit)).rejects.toThrow('test cipher unavailable');
    expect(await store.get(input.scope, draft.id, 'builder')).toEqual(draft);
    fail = false;
    expect(await store.edit(edit)).toMatchObject({ revision: 2 });
  });
});

import { randomUUID } from 'node:crypto';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresApplicationDraftBackend } from '../src/application-drafts/postgres.js';
import { ApplicationDraftStore } from '../src/application-drafts/store.js';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';
import { PostgresBusinessWorkspaceBackend } from '../src/business-workspaces/postgres.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { describeBusinessWorkspaceStore } from './business-workspace-suite.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(databaseUrl === undefined)('PostgreSQL workspace authority', () => {
  const schema = `workspace_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 3000,
  });
  const cipher = new SecretBoxPayloadCipher(
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 11).toString('base64'))),
  );
  const backend = new PostgresBusinessWorkspaceBackend(pool, cipher);
  const draftBackend = new PostgresApplicationDraftBackend(pool, cipher);
  const options = { isIdentityActive: async () => true };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await backend.ensureSchema();
    await backend.ensureSchema();
    await draftBackend.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  describeBusinessWorkspaceStore(async () => {
    // Only this test's private schema; each shared conformance case starts with no authority.
    await pool.query('DELETE FROM business_workspace_authority_events');
    await pool.query('DELETE FROM business_workspace_authority');
    return backend;
  });

  it('recovers roles after restart with no plaintext invitation email or token at rest', async () => {
    const store = new BusinessWorkspaceStore(backend, options);
    const org = `org-${randomUUID()}`;
    await store.initializeNewWorkspace({ org, ownerSubject: 'owner' });
    const invitation = await store.invite({
      org,
      actor: 'owner',
      expectedRevision: 1,
      email: 'private-member@example.test',
      role: 'builder',
    });
    const rows = await pool.query('SELECT * FROM business_workspace_authority WHERE org = $1', [
      org,
    ]);
    const events = await pool.query(
      'SELECT * FROM business_workspace_authority_events WHERE org = $1',
      [org],
    );
    const persisted = JSON.stringify([rows.rows, events.rows]);
    expect(persisted).not.toContain(invitation.token);
    expect(persisted).not.toContain('private-member@example.test');
    const restarted = new BusinessWorkspaceStore(
      new PostgresBusinessWorkspaceBackend(pool, cipher),
      options,
    );
    await restarted.accept({
      org,
      token: invitation.token,
      subject: 'builder',
      verifiedEmail: 'private-member@example.test',
    });
    expect(await restarted.authorize(org, 'builder', 'drafts:edit')).toBe('allowed');
    expect(await restarted.authorize(org, 'builder', 'records:read')).toBe('denied');
  });

  it('uses the draft transaction connection to recheck roles and rejects replay after revocation', async () => {
    const store = new BusinessWorkspaceStore(backend, options);
    const org = `org-${randomUUID()}`;
    await store.initializeNewWorkspace({ org, ownerSubject: 'owner' });
    const invitation = await store.invite({
      org,
      actor: 'owner',
      expectedRevision: 1,
      email: 'builder@example.test',
      role: 'builder',
    });
    await store.accept({
      org,
      token: invitation.token,
      subject: 'builder',
      verifiedEmail: 'builder@example.test',
    });
    const drafts = new ApplicationDraftStore(draftBackend, {
      authorize: async (scope, actor, permission) =>
        (await store.authorize(scope.org, actor, permission)) === 'allowed',
    });
    const input = {
      scope: { org, app: 'assistant' },
      actorSubject: 'builder',
      environment: 'prod',
      idempotencyKey: randomUUID(),
      source: {
        entrypoint: 'server.ts',
        files: [{ path: 'server.ts', content: 'export default {};' }],
      },
    };
    const draft = await drafts.create(input);
    await store.changeRole({
      org,
      actor: 'owner',
      expectedRevision: 3,
      subject: 'builder',
      role: null,
    });
    await expect(drafts.create(input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(drafts.get(input.scope, draft.id, 'builder')).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await drafts.get(input.scope, draft.id, 'owner')).revision).toBe(1);
  });

  it('rolls back workspace creation and audit when another transaction participant fails', async () => {
    const store = new BusinessWorkspaceStore(backend, options);
    const org = `org-${randomUUID()}`;
    await expect(
      withPostgresTransaction(pool, async () => {
        await store.initializeNewWorkspace({ org, ownerSubject: 'owner' });
        throw new Error('test provisioning failed');
      }),
    ).rejects.toThrow('test provisioning failed');
    expect(await backend.read(org)).toBeUndefined();
    expect(
      (await pool.query('SELECT * FROM business_workspace_authority_events WHERE org = $1', [org]))
        .rowCount,
    ).toBe(0);
  });
});

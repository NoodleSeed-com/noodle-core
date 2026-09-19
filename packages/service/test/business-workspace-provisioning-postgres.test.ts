import { randomUUID } from 'node:crypto';
import { personalOrgSlug } from '@noodle-borg/control-plane';
import { SecretBox, staticMasterKeyProvider } from '@noodle-borg/runtime';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecretBoxPayloadCipher } from '../src/business-information-cipher.js';
import { PostgresBusinessWorkspaceBackend } from '../src/business-workspaces/postgres.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(!databaseUrl)('atomic fresh business workspace provisioning', () => {
  const schema = `workspace_signup_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  // One connection detects nested transaction participants that incorrectly borrow a second connection.
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const cipher = new SecretBoxPayloadCipher(
    new SecretBox(staticMasterKeyProvider(Buffer.alloc(32, 17).toString('base64'))),
  );
  const backend = new PostgresBusinessWorkspaceBackend(pool, cipher);
  const workspace = new BusinessWorkspaceStore(backend, { isIdentityActive: async () => true });
  const created = vi.fn(async (input: { readonly org: string; readonly ownerSubject: string }) => {
    await workspace.initializeNewWorkspace(input);
  });
  const store = new PostgresArtifactStore(pool, {
    now: () => new Date(),
    personalWorkspaceCreated: created,
  });
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.ensureSchema();
    await backend.ensureSchema();
    await pool.query('CREATE TABLE provisioning_probe (org TEXT PRIMARY KEY)');
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });
  function input() {
    const subject = `owner-${randomUUID()}`;
    const email = `${subject}@example.test`;
    return { subject, email, slug: personalOrgSlug({ subject, email }), displayName: 'Business' };
  }
  async function expectAbsent(org: string) {
    expect(await store.getOrg(org)).toBeUndefined();
    expect(await backend.read(org)).toBeUndefined();
    expect(
      (await pool.query('SELECT * FROM provisioning_probe WHERE org = $1', [org])).rows,
    ).toEqual([]);
    for (const table of ['org_members', 'personal_workspace_bindings', 'welcome_email_outbox']) {
      expect((await pool.query(`SELECT * FROM ${table} WHERE org_slug = $1`, [org])).rows).toEqual(
        [],
      );
    }
    expect(
      (await pool.query('SELECT * FROM business_workspace_authority_events WHERE org = $1', [org]))
        .rows,
    ).toEqual([]);
  }
  it('commits one Owner, binding, outbox and audit under concurrent signup retries', async () => {
    const user = input();
    const before = created.mock.calls.length;
    const results = await Promise.all([
      store.provisionPersonalWorkspace(user),
      store.provisionPersonalWorkspace(user),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(created.mock.calls.length - before).toBe(1);
    expect((await workspace.inspect(user.slug, user.subject)).role).toBe('owner');
    expect(
      (await pool.query('SELECT * FROM welcome_email_outbox WHERE subject = $1', [user.subject]))
        .rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('SELECT * FROM business_workspace_authority_events WHERE org = $1', [
          user.slug,
        ])
      ).rowCount,
    ).toBe(1);
  });
  it('rolls back all signup state if encrypted Owner initialization fails', async () => {
    const user = input();
    const failing = new PostgresArtifactStore(pool, {
      now: () => new Date(),
      organizationProvisioning: {
        id: 'test',
        provision: async (tx, value) => {
          if (!tx) throw new Error('transaction required');
          await tx.query('INSERT INTO provisioning_probe (org) VALUES ($1)', [value.org]);
        },
      },
      personalWorkspaceCreated: async (scope) => {
        await workspace.initializeNewWorkspace(scope);
        throw new Error('test workspace initialization failed');
      },
    });
    await expect(failing.provisionPersonalWorkspace(user)).rejects.toThrow(
      'test workspace initialization failed',
    );
    await expectAbsent(user.slug);
    expect((await store.provisionPersonalWorkspace(user)).created).toBe(true);
  });
  it('shares the caller transaction and rolls everything back if a later participant fails', async () => {
    const user = input();
    await expect(
      withPostgresTransaction(pool, async () => {
        await store.provisionPersonalWorkspace(user);
        throw new Error('test outer participant failed');
      }),
    ).rejects.toThrow('test outer participant failed');
    await expectAbsent(user.slug);
  });
  it('never initializes an existing immutable binding when the new role composition is enabled later', async () => {
    const user = input();
    await new PostgresArtifactStore(pool).provisionPersonalWorkspace(user);
    const before = created.mock.calls.length;
    expect(
      (await store.provisionPersonalWorkspace({ ...user, email: 'changed@example.test' })).created,
    ).toBe(false);
    expect(created.mock.calls.length).toBe(before);
    expect(await backend.read(user.slug)).toBeUndefined();
  });
  it('recognizes a fresh-only options object and preserves an unrelated existing organization', async () => {
    const user = input();
    const configured = new PostgresArtifactStore(pool, { personalWorkspaceCreated: created });
    await configured.provisionPersonalWorkspace(user);
    expect((await workspace.inspect(user.slug, user.subject)).role).toBe('owner');
    const other = input();
    await expect(
      configured.provisionPersonalWorkspace({ ...other, slug: user.slug }),
    ).rejects.toThrow('already assigned');
    expect((await workspace.inspect(user.slug, user.subject)).members).toHaveLength(1);
  });
  it('refuses an outer commit even if its caller catches a failed fresh-workspace participant', async () => {
    const user = input();
    const failing = new PostgresArtifactStore(pool, {
      personalWorkspaceCreated: async (scope) => {
        await workspace.initializeNewWorkspace(scope);
        throw new Error('test caught participant failure');
      },
    });
    await expect(
      withPostgresTransaction(pool, async () => {
        await expect(failing.provisionPersonalWorkspace(user)).rejects.toThrow(
          'test caught participant failure',
        );
      }),
    ).rejects.toThrow('test caught participant failure');
    await expectAbsent(user.slug);
  });
  it('never initializes a discovered legacy workspace or an explicit developer organization', async () => {
    const user = input();
    const before = created.mock.calls.length;
    await store.createOrgWithOwner({
      slug: user.slug,
      owner: { subject: user.subject, email: user.email },
    });
    expect((await store.provisionPersonalWorkspace(user)).created).toBe(false);
    expect(created.mock.calls.length).toBe(before);
    expect(await backend.read(user.slug)).toBeUndefined();
  });
  it('does not leave authority when commercial provisioning refuses the signup', async () => {
    const user = input();
    const failing = new PostgresArtifactStore(pool, {
      personalWorkspaceCreated: created,
      organizationProvisioning: {
        id: 'test',
        provision: async () => {
          throw new Error('test commercial provisioning failed');
        },
      },
    });
    await expect(failing.provisionPersonalWorkspace(user)).rejects.toThrow(
      'test commercial provisioning failed',
    );
    await expectAbsent(user.slug);
  });
});

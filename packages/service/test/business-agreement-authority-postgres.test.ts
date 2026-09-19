import { randomUUID } from 'node:crypto';
import { agreementDocumentDigest } from '@noodle-borg/control-plane/portable';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBusinessInformationStore } from '../src/business-information/postgres-store.js';
import { BusinessOnboarding } from '../src/business-onboarding.js';
import { PostgresBusinessWorkspaceBackend } from '../src/business-workspaces/postgres.js';
import { BusinessWorkspaceStore } from '../src/business-workspaces/store.js';
import { PostgresArtifactStore } from '../src/store/postgres.js';
import { withPostgresTransaction } from '../src/store/postgres-transaction.js';
import { TestPayloadCipher } from './business-information-test-cipher.js';

function barrier() {
  let resolve: () => void = () => {
    throw new Error('barrier not initialized');
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const connectionString = process.env.DATABASE_URL_TEST;
describe.skipIf(!connectionString)('business agreement transaction composition', () => {
  const schema = `agreement_authority_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, max: 1 });
  const pool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const secondPool = new Pool({
    connectionString,
    max: 1,
    options: `-c search_path=${schema}`,
    connectionTimeoutMillis: 1000,
  });
  const cipher = new TestPayloadCipher();
  const organizations = new PostgresArtifactStore(pool);
  const installations = new PostgresBusinessInformationStore(pool, cipher);
  const backend = new PostgresBusinessWorkspaceBackend(pool, cipher);
  const documents = {
    version: 'workspace-pg',
    terms: { url: 'https://example.test/terms', sha256: 'a'.repeat(64) },
    privacy: { url: 'https://example.test/privacy', sha256: 'b'.repeat(64) },
    processing: { url: 'https://example.test/processing', sha256: 'c'.repeat(64) },
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await organizations.ensureSchema();
    await backend.ensureSchema();
  });
  afterAll(async () => {
    await secondPool.end();
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  async function fixture() {
    const org = `business-${randomUUID()}`;
    await organizations.createOrg({ slug: org });
    await organizations.addOrgMember({
      org,
      subject: 'legacy-owner',
      email: 'legacy@example.test',
      role: 'owner',
    });
    const workspaces = new BusinessWorkspaceStore(backend, {
      isIdentityActive: async (_subject, transaction) => {
        // A real borrowed query catches accidental second-connection acquisition with max: 1.
        await (transaction ?? pool).query('SELECT 1');
        return true;
      },
    });
    await workspaces.initializeNewWorkspace({ org, ownerSubject: 'owner' });
    const onboarding = new BusinessOnboarding(
      { documents },
      organizations,
      installations,
      workspaces,
    );
    const accept = {
      version: documents.version,
      documentDigest: agreementDocumentDigest(documents),
    };
    return { org, workspaces, onboarding, accept };
  }
  it('borrows the workspace connection, persists across restart and keeps the first acceptance', async () => {
    const { org, onboarding, accept } = await fixture();
    expect(await onboarding.accept(org, 'owner', accept)).toMatchObject({
      accepted: true,
      canAccept: true,
    });
    const receipt = await organizations.getOrganizationAgreement(org, documents.version);
    expect(receipt?.actorSubject).toBe('owner');
    const reopened = new PostgresArtifactStore(secondPool);
    expect(await reopened.getOrganizationAgreement(org, documents.version)).toEqual(receipt);
    await onboarding.accept(org, 'owner', accept);
    expect(await reopened.getOrganizationAgreement(org, documents.version)).toEqual(receipt);
    await expect(onboarding.accept(org, 'legacy-owner', accept)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('rolls back acceptance and catalog registration with the enclosing transaction', async () => {
    const { org, workspaces } = await fixture();
    const selected = { ...documents, version: `rollback-${randomUUID()}` };
    const onboarding = new BusinessOnboarding(
      { documents: selected },
      organizations,
      installations,
      workspaces,
    );
    await expect(
      withPostgresTransaction(pool, async () => {
        await onboarding.accept(org, 'owner', {
          version: selected.version,
          documentDigest: agreementDocumentDigest(selected),
        });
        throw new Error('synthetic rollback');
      }),
    ).rejects.toThrow('synthetic rollback');
    expect(await organizations.getOrganizationAgreement(org, selected.version)).toBeUndefined();
    expect(
      (
        await pool.query('SELECT 1 FROM organization_agreement_documents WHERE version=$1', [
          selected.version,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('joins legacy checks when the workspace authority is absent, without creating a workspace', async () => {
    const org = `legacy-${randomUUID()}`;
    await organizations.createOrg({ slug: org });
    await organizations.addOrgMember({
      org,
      subject: 'legacy-owner',
      email: 'legacy@example.test',
      role: 'owner',
    });
    const workspaces = new BusinessWorkspaceStore(backend, { isIdentityActive: async () => true });
    const onboarding = new BusinessOnboarding(
      { documents },
      organizations,
      installations,
      workspaces,
    );
    expect(
      await onboarding.accept(org, 'legacy-owner', {
        version: documents.version,
        documentDigest: agreementDocumentDigest(documents),
      }),
    ).toMatchObject({ accepted: true });
    expect(await backend.read(org)).toBeUndefined();
  });

  it('serializes acceptance behind concurrent Owner removal on another service instance', async () => {
    const { org, workspaces, onboarding, accept } = await fixture();
    const invited = await workspaces.invite({
      org,
      actor: 'owner',
      expectedRevision: (await workspaces.inspect(org, 'owner')).revision,
      email: 'second@example.test',
      role: 'owner',
    });
    await workspaces.accept({
      org,
      subject: 'second-owner',
      verifiedEmail: 'second@example.test',
      token: invited.token,
    });
    const other = new BusinessWorkspaceStore(
      new PostgresBusinessWorkspaceBackend(secondPool, cipher),
      { isIdentityActive: async () => true },
    );
    const held = barrier();
    const release = barrier();
    const revision = (await workspaces.inspect(org, 'owner')).revision;
    const removal = withPostgresTransaction(secondPool, async () => {
      await other.changeRole({
        org,
        actor: 'second-owner',
        expectedRevision: revision,
        subject: 'owner',
        role: null,
      });
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const acceptance = expect(onboarding.accept(org, 'owner', accept)).rejects.toMatchObject({
      code: 'forbidden',
    });
    release.resolve();
    await removal;
    await acceptance;
    expect(await organizations.getOrganizationAgreement(org, documents.version)).toBeUndefined();
  });

  it('does not fall back to a legacy Owner when versioned authority cannot be read', async () => {
    const { org, onboarding, accept } = await fixture();
    await pool.query(
      "UPDATE business_workspace_authority SET sealed_state='{}'::jsonb WHERE org=$1",
      [org],
    );
    await expect(onboarding.accept(org, 'legacy-owner', accept)).rejects.toThrow(
      'workspace authority unavailable',
    );
    expect(await organizations.getOrganizationAgreement(org, documents.version)).toBeUndefined();
  });
});

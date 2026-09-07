import type { Pool } from 'pg';
import {
  type AcceptOrganizationAgreementInput,
  type AgreementDocuments,
  agreementDocumentDigest,
  type OrganizationAgreementAcceptance,
  OrganizationAgreementError,
  validateAgreementDocuments,
} from './organization-agreements.js';
import { validateSlug } from './validation.js';

export async function ensureOrganizationAgreementSchema(pool: Pool): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS organization_agreement_documents (
    version text PRIMARY KEY,
    document_digest text NOT NULL CHECK (document_digest ~ '^[a-f0-9]{64}$'),
    documents jsonb NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS organization_agreement_acceptances (
    org_slug text NOT NULL REFERENCES orgs(slug),
    version text NOT NULL REFERENCES organization_agreement_documents(version),
    actor_subject text NOT NULL,
    accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (org_slug, version)
  )`);
}

interface AcceptanceRow {
  readonly org_slug: string;
  readonly actor_subject: string;
  readonly accepted_at: Date;
  readonly documents: AgreementDocuments;
  readonly document_digest: string;
}

const ACCEPTANCE_SELECT = `SELECT a.org_slug, a.actor_subject, a.accepted_at, d.documents, d.document_digest
  FROM organization_agreement_acceptances a JOIN organization_agreement_documents d USING (version)
  WHERE a.org_slug=$1 AND a.version=$2`;

function receipt(row: AcceptanceRow): OrganizationAgreementAcceptance {
  return {
    org: row.org_slug,
    actorSubject: row.actor_subject,
    documents: row.documents,
    documentDigest: row.document_digest,
    acceptedAt: row.accepted_at.toISOString(),
  };
}

export async function getOrganizationAgreementRow(
  pool: Pick<Pool, 'query'>,
  org: string,
  version: string,
): Promise<OrganizationAgreementAcceptance | undefined> {
  const { rows } = await pool.query<AcceptanceRow>(ACCEPTANCE_SELECT, [
    validateSlug('org', org),
    version,
  ]);
  return rows[0] ? receipt(rows[0]) : undefined;
}

/** Catalog identity and exact-owner receipt commit together; no update/delete operation is exposed. */
export async function acceptOrganizationAgreementRow(
  pool: Pool,
  input: AcceptOrganizationAgreementInput,
): Promise<OrganizationAgreementAcceptance> {
  const org = validateSlug('org', input.org);
  const documents = validateAgreementDocuments(input.documents);
  const documentDigest = agreementDocumentDigest(documents);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: members } = await client.query<{ role: string }>(
      'SELECT role FROM org_members WHERE org_slug=$1 AND subject=$2 FOR UPDATE',
      [org, input.actorSubject],
    );
    if (members[0]?.role !== 'owner')
      throw new OrganizationAgreementError('agreement_owner_required');
    await client.query(
      `INSERT INTO organization_agreement_documents (version, document_digest, documents)
      VALUES ($1,$2,$3::jsonb) ON CONFLICT (version) DO NOTHING`,
      [documents.version, documentDigest, JSON.stringify(documents)],
    );
    const { rows: registered } = await client.query<{ document_digest: string }>(
      'SELECT document_digest FROM organization_agreement_documents WHERE version=$1',
      [documents.version],
    );
    if (registered[0]?.document_digest !== documentDigest)
      throw new OrganizationAgreementError('agreement_version_conflict');
    await client.query(
      `INSERT INTO organization_agreement_acceptances (org_slug, version, actor_subject)
      VALUES ($1,$2,$3) ON CONFLICT (org_slug,version) DO NOTHING`,
      [org, documents.version, input.actorSubject],
    );
    const { rows } = await client.query<AcceptanceRow>(ACCEPTANCE_SELECT, [org, documents.version]);
    if (!rows[0]) throw new Error('Agreement receipt unavailable');
    const result = receipt(rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

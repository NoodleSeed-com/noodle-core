import {
  APPLICATION_DRAFT_LIMITS,
  type ApplicationDraft,
  ApplicationDraftSchema,
  ApplicationDraftSourceSchema,
} from '@noodle-borg/wire-contracts';
import type { Pool, PoolClient } from 'pg';
import { validateSealedPayload } from '../business-information/cipher.js';
import type { PayloadCipher, PayloadCipherContext } from '../business-information/contracts.js';
import { withPostgresTransaction } from '../store/postgres-transaction.js';
import type {
  ApplicationDraftBackend,
  ApplicationDraftScope,
  ApplicationDraftTransaction,
  DraftReceipt,
} from './contracts.js';
import { applicationDraftSourceBytes, applicationDraftSourceDigest } from './store.js';

const metadataSchema = ApplicationDraftSchema.omit({ source: true });
// JSON can escape each source byte to six characters. The shared key custodian adds
// three base64 envelopes (< 3x), plus bounded context and file metadata.
const maximumSealedSource = 3 * (6 * APPLICATION_DRAFT_LIMITS.totalBytes + 32_768) + 65_536;
type Metadata = Omit<ApplicationDraft, 'source'>;
interface DraftRow {
  readonly metadata: unknown;
  readonly sealed_source: unknown;
}

/** Authoritative encrypted revisions and retry receipts; no process-local production fallback. */
export class PostgresApplicationDraftBackend implements ApplicationDraftBackend {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: PayloadCipher,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS application_draft_revisions (
        org TEXT NOT NULL,
        app TEXT NOT NULL,
        draft_id UUID NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        metadata JSONB NOT NULL,
        sealed_source JSONB NOT NULL,
        source_bytes INTEGER NOT NULL CHECK (source_bytes >= 0),
        PRIMARY KEY (org, app, draft_id, revision)
      );
      CREATE TABLE IF NOT EXISTS application_draft_receipts (
        org TEXT NOT NULL,
        app TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        draft_id UUID NOT NULL,
        revision INTEGER NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (org, app, receipt_key)
      );
    `);
  }

  run<T>(
    scope: ApplicationDraftScope,
    operation: (transaction: ApplicationDraftTransaction) => Promise<T>,
  ): Promise<T> {
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `business-workspace:${scope.org}`,
      ]);
      const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const now = time.rows[0]?.now;
      if (!now) throw new Error('draft transaction clock unavailable');
      return operation({
        now: now.toISOString(),
        get: (id, revision) => this.get(client, scope, id, revision),
        heads: async () => {
          const result = await client.query<{ metadata: unknown }>(
            `SELECT DISTINCT ON (draft_id) metadata
               FROM application_draft_revisions WHERE org = $1 AND app = $2
              ORDER BY draft_id, revision DESC`,
            [scope.org, scope.app],
          );
          return result.rows.map((row) => this.metadata(scope, row.metadata));
        },
        history: async (id) => {
          const result = await client.query<{ metadata: unknown }>(
            'SELECT metadata FROM application_draft_revisions WHERE org = $1 AND app = $2 AND draft_id = $3 ORDER BY revision DESC',
            [scope.org, scope.app, id],
          );
          return result.rows.map((row) => this.metadata(scope, row.metadata));
        },
        capacity: async () => {
          await client.query(
            'DELETE FROM application_draft_receipts WHERE org = $1 AND expires_at <= $2',
            [scope.org, now],
          );
          const usage = await client.query<{
            drafts: string;
            source_bytes: string;
            receipts: string;
          }>(
            `
            SELECT COUNT(DISTINCT (app, draft_id)) AS drafts, COALESCE(SUM(source_bytes), 0) AS source_bytes,
              (SELECT COUNT(*) FROM application_draft_receipts WHERE org = $1) AS receipts
            FROM application_draft_revisions WHERE org = $1`,
            [scope.org],
          );
          const row = usage.rows[0];
          if (!row) throw new Error('draft capacity unavailable');
          return {
            drafts: Number(row.drafts),
            sourceBytes: Number(row.source_bytes),
            receipts: Number(row.receipts),
          };
        },
        append: async (draft) => {
          const parsed = ApplicationDraftSchema.parse(draft);
          const { source, ...metadata } = parsed;
          if (metadata.org !== scope.org || metadata.app !== scope.app) {
            throw new Error('draft scope mismatch');
          }
          const sealed = validateSealedPayload(
            await this.cipher.seal(
              new TextEncoder().encode(JSON.stringify(source)),
              cipherContext(metadata),
            ),
            maximumSealedSource,
          );
          await client.query(
            `INSERT INTO application_draft_revisions
              (org, app, draft_id, revision, metadata, sealed_source, source_bytes)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
            [
              scope.org,
              scope.app,
              metadata.id,
              metadata.revision,
              JSON.stringify(metadata),
              JSON.stringify(sealed),
              applicationDraftSourceBytes(source),
            ],
          );
        },
        receipt: async (key) => {
          const result = await client.query<{
            fingerprint: string;
            draft_id: string;
            revision: number;
            expires_at: Date;
          }>(
            `SELECT fingerprint, draft_id, revision, expires_at FROM application_draft_receipts
             WHERE org = $1 AND app = $2 AND receipt_key = $3 AND expires_at > $4`,
            [scope.org, scope.app, key, now],
          );
          const row = result.rows[0];
          return row
            ? {
                fingerprint: row.fingerprint,
                draftId: row.draft_id,
                revision: row.revision,
                expiresAt: row.expires_at.toISOString(),
              }
            : undefined;
        },
        saveReceipt: (key, receipt) => this.saveReceipt(client, scope, key, receipt),
        remove: async (id) => {
          await client.query(
            'DELETE FROM application_draft_revisions WHERE org = $1 AND app = $2 AND draft_id = $3',
            [scope.org, scope.app, id],
          );
        },
      });
    });
  }

  private async get(
    client: PoolClient,
    scope: ApplicationDraftScope,
    id: string,
    revision?: number,
  ): Promise<ApplicationDraft | undefined> {
    const result = await client.query<DraftRow>(
      `SELECT metadata, sealed_source FROM application_draft_revisions
       WHERE org = $1 AND app = $2 AND draft_id = $3
         AND ($4::integer IS NULL OR revision = $4)
       ORDER BY revision DESC LIMIT 1`,
      [scope.org, scope.app, id, revision ?? null],
    );
    return result.rows[0] ? this.open(scope, result.rows[0]) : undefined;
  }

  private async open(scope: ApplicationDraftScope, row: DraftRow): Promise<ApplicationDraft> {
    try {
      const metadata = this.metadata(scope, row.metadata);
      const bytes = await this.cipher.open(
        validateSealedPayload(row.sealed_source, maximumSealedSource),
        cipherContext(metadata),
      );
      const source = ApplicationDraftSourceSchema.parse(
        JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes)),
      );
      if (applicationDraftSourceDigest(source) !== metadata.sourceDigest) throw new Error('digest');
      return { ...metadata, source };
    } catch {
      // Schema/cipher failures must not reflect customer source, credentials or ciphertext.
      throw new Error('draft revision unavailable');
    }
  }

  private metadata(scope: ApplicationDraftScope, value: unknown): Metadata {
    const metadata = metadataSchema.parse(value);
    if (metadata.org !== scope.org || metadata.app !== scope.app)
      throw new Error('draft scope mismatch');
    return metadata;
  }

  private async saveReceipt(
    client: PoolClient,
    scope: ApplicationDraftScope,
    key: string,
    receipt: DraftReceipt,
  ): Promise<void> {
    await client.query(
      `INSERT INTO application_draft_receipts
        (org, app, receipt_key, fingerprint, draft_id, revision, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        scope.org,
        scope.app,
        key,
        receipt.fingerprint,
        receipt.draftId,
        receipt.revision,
        receipt.expiresAt,
      ],
    );
  }
}

function cipherContext(metadata: Metadata): PayloadCipherContext {
  return {
    org: metadata.org,
    app: metadata.app,
    env: metadata.environment,
    installationId: `draft:${metadata.id}`,
    collectionKey: 'application_source',
    recordId: metadata.id,
    revision: metadata.revision,
  };
}

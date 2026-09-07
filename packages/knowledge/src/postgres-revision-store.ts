/**
 * Durable knowledge revision store: Postgres parity for the deploy-coupled publication
 * transaction (ADR 0202). Every state transition the in-memory store makes in one process,
 * this store makes atomically across every service instance:
 *
 * - stage is idempotent on (scope, content_hash);
 * - activate retires the previous active revision and pins the deployment in one transaction;
 * - rollback reselects exactly the revision the target deployment pinned;
 * - GC removes only revisions that are neither active nor pinned;
 * - leases serialize publication per component/scope with a bounded timeout.
 */
import type { Pool } from 'pg';
import type { KnowledgeScope } from './ir.js';
import { knowledgeScopeKey } from './ir.js';
import { KnowledgeError, type KnowledgeRevision, type StagedDocument } from './ports.js';
import {
  type DocumentTextCodec,
  identityDocumentTextCodec,
  type KnowledgeRevisionStore,
  type LeaseTicket,
  type RevisionRecord,
  type StageRevisionInput,
} from './revision-store.js';

const LEASE_TIMEOUT_MS = 60_000;

interface RevisionRow {
  revision_id: string;
  org: string;
  app: string;
  env: string;
  component_name: string;
  content_hash: string;
  state: 'staged' | 'active' | 'retired';
  documents: KnowledgeRevision['documents'];
  staged_at: string;
}

export class PostgresKnowledgeRevisionStore implements KnowledgeRevisionStore {
  readonly #pool: Pool;
  readonly #codec: DocumentTextCodec;

  constructor(pool: Pool, codec: DocumentTextCodec = identityDocumentTextCodec) {
    this.#pool = pool;
    this.#codec = codec;
  }

  async ensureSchema(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_revisions (
        revision_id text PRIMARY KEY,
        org text NOT NULL,
        app text NOT NULL,
        env text NOT NULL,
        component_name text NOT NULL,
        content_hash text NOT NULL,
        state text NOT NULL DEFAULT 'staged',
        documents jsonb NOT NULL,
        staged_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org, app, env, component_name, content_hash)
      )
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_deployment_pins (
        deployment_id text NOT NULL,
        revision_id text NOT NULL REFERENCES knowledge_revisions (revision_id) ON DELETE CASCADE,
        PRIMARY KEY (deployment_id, revision_id)
      )
    `);
    // Pre-pin-per-component rows used deployment_id alone as the key; widen in place.
    await this.#pool.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_name = 'knowledge_deployment_pins'
            AND constraint_type = 'PRIMARY KEY'
            AND constraint_name = 'knowledge_deployment_pins_pkey'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.key_column_usage
          WHERE table_name = 'knowledge_deployment_pins'
            AND constraint_name = 'knowledge_deployment_pins_pkey'
            AND column_name = 'revision_id'
        ) THEN
          ALTER TABLE knowledge_deployment_pins DROP CONSTRAINT knowledge_deployment_pins_pkey;
          ALTER TABLE knowledge_deployment_pins ADD PRIMARY KEY (deployment_id, revision_id);
        END IF;
      END $$;
    `);
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_publication_leases (
        scope_key text PRIMARY KEY,
        holder text NOT NULL,
        acquired_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Sealed revision text (ADR 0202 D5 as amended): lets any stateless instance rebuild the
    // bundled BM25 index for the active revision. Ciphertext only; the codec owner holds keys.
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS knowledge_revision_documents (
        revision_id text NOT NULL REFERENCES knowledge_revisions (revision_id) ON DELETE CASCADE,
        path text NOT NULL,
        ciphertext bytea NOT NULL,
        bytes integer NOT NULL,
        PRIMARY KEY (revision_id, path)
      )
    `);
  }

  async stage(input: StageRevisionInput): Promise<KnowledgeRevision> {
    const result = await this.#pool.query<RevisionRow>(
      `INSERT INTO knowledge_revisions (revision_id, org, app, env, component_name, content_hash, documents)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (org, app, env, component_name, content_hash) DO NOTHING
       RETURNING revision_id, org, app, env, component_name, content_hash, state, documents, staged_at`,
      [
        input.revision.revisionId,
        input.scope.org,
        input.scope.app,
        input.scope.env,
        input.componentName,
        input.contentHash,
        JSON.stringify(input.revision.documents),
      ],
    );
    if (result.rows[0] !== undefined) return this.toRevision(result.rows[0]);
    // Idempotent reuse: the unique scope+hash row already exists.
    const existing = await this.#pool.query<RevisionRow>(
      `SELECT revision_id, org, app, env, component_name, content_hash, state, documents, staged_at
       FROM knowledge_revisions
       WHERE org = $1 AND app = $2 AND env = $3 AND component_name = $4 AND content_hash = $5`,
      [input.scope.org, input.scope.app, input.scope.env, input.componentName, input.contentHash],
    );
    const row = existing.rows[0];
    if (row === undefined)
      throw new KnowledgeError('store', 'staged revision disappeared mid-transaction');
    return this.toRevision(row);
  }

  async acquireLease(
    scope: KnowledgeScope,
    componentName: string,
    holder: string,
  ): Promise<LeaseTicket> {
    const scopeKey = knowledgeScopeKey(scope, componentName);
    for (;;) {
      const result = await this.#pool.query<{ scope_key: string }>(
        `INSERT INTO knowledge_publication_leases (scope_key, holder, acquired_at)
         VALUES ($1, $2, now())
         ON CONFLICT (scope_key) DO UPDATE
           SET holder = $2, acquired_at = now()
           WHERE knowledge_publication_leases.acquired_at < now() - interval '${LEASE_TIMEOUT_MS} milliseconds'
         RETURNING scope_key`,
        [scopeKey, holder],
      );
      if (result.rows[0] !== undefined) {
        return { scopeKey, leaseId: `${scopeKey}:${holder}` };
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async releaseLease(ticket: LeaseTicket): Promise<void> {
    await this.#pool.query('DELETE FROM knowledge_publication_leases WHERE scope_key = $1', [
      ticket.scopeKey,
    ]);
  }

  async activate(
    scope: KnowledgeScope,
    componentName: string,
    revisionId: string,
    deploymentId: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query<RevisionRow>(
        'SELECT * FROM knowledge_revisions WHERE revision_id = $1 FOR UPDATE',
        [revisionId],
      );
      if (existing.rows[0] === undefined) {
        await client.query('ROLLBACK');
        throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
      }
      await client.query(
        `UPDATE knowledge_revisions SET state = 'retired'
         WHERE org = $1 AND app = $2 AND env = $3 AND component_name = $4 AND state = 'active' AND revision_id <> $5`,
        [scope.org, scope.app, scope.env, componentName, revisionId],
      );
      await client.query(`UPDATE knowledge_revisions SET state = 'active' WHERE revision_id = $1`, [
        revisionId,
      ]);
      await client.query(
        `INSERT INTO knowledge_deployment_pins (deployment_id, revision_id)
         VALUES ($1, $2)
         ON CONFLICT (deployment_id, revision_id) DO NOTHING`,
        [deploymentId, revisionId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async pin(revisionId: string, deploymentId: string): Promise<void> {
    await this.#pool.query(
      `INSERT INTO knowledge_deployment_pins (deployment_id, revision_id)
       VALUES ($1, $2)
       ON CONFLICT (deployment_id, revision_id) DO NOTHING`,
      [deploymentId, revisionId],
    );
  }

  async unpin(revisionId: string, deploymentId: string): Promise<void> {
    await this.#pool.query(
      'DELETE FROM knowledge_deployment_pins WHERE deployment_id = $1 AND revision_id = $2',
      [deploymentId, revisionId],
    );
  }

  async rollback(deploymentId: string): Promise<readonly KnowledgeRevision[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const pinned = await client.query<{ revision_id: string }>(
        'SELECT revision_id FROM knowledge_deployment_pins WHERE deployment_id = $1',
        [deploymentId],
      );
      const restored: KnowledgeRevision[] = [];
      for (const pin of pinned.rows) {
        const target = await client.query<RevisionRow>(
          'SELECT * FROM knowledge_revisions WHERE revision_id = $1',
          [pin.revision_id],
        );
        const row = target.rows[0];
        if (row === undefined) continue;
        const scope = this.rowScope(row);
        await client.query(
          `UPDATE knowledge_revisions SET state = 'retired'
           WHERE org = $1 AND app = $2 AND env = $3 AND component_name = $4 AND state = 'active' AND revision_id <> $5`,
          [scope.org, scope.app, scope.env, row.component_name, pin.revision_id],
        );
        await client.query(
          `UPDATE knowledge_revisions SET state = 'active' WHERE revision_id = $1`,
          [pin.revision_id],
        );
        restored.push(this.toRevision(row));
      }
      await client.query('COMMIT');
      return restored;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async collectGarbage(): Promise<number> {
    const result = await this.#pool.query(
      `DELETE FROM knowledge_revisions r
       WHERE r.state <> 'active'
         AND NOT EXISTS (
           SELECT 1 FROM knowledge_deployment_pins p WHERE p.revision_id = r.revision_id
         )`,
    );
    return result.rowCount ?? 0;
  }

  async active(
    scope: KnowledgeScope,
    componentName: string,
  ): Promise<KnowledgeRevision | undefined> {
    const result = await this.#pool.query<RevisionRow>(
      `SELECT * FROM knowledge_revisions
       WHERE org = $1 AND app = $2 AND env = $3 AND component_name = $4 AND state = 'active'`,
      [scope.org, scope.app, scope.env, componentName],
    );
    return result.rows[0] === undefined ? undefined : this.toRevision(result.rows[0]);
  }

  async record(revisionId: string): Promise<RevisionRecord | undefined> {
    const result = await this.#pool.query<RevisionRow>(
      'SELECT * FROM knowledge_revisions WHERE revision_id = $1',
      [revisionId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const pins = await this.#pool.query<{ deployment_id: string }>(
      'SELECT deployment_id FROM knowledge_deployment_pins WHERE revision_id = $1',
      [revisionId],
    );
    return {
      revision: this.toRevision(row),
      contentHash: row.content_hash,
      state: row.state,
      pins: new Set(pins.rows.map((pin) => pin.deployment_id)),
      stagedAt: new Date(row.staged_at).getTime(),
    };
  }

  async delete(revisionId: string): Promise<void> {
    const record = await this.record(revisionId);
    if (record === undefined) return;
    if (record.state === 'active') {
      throw new KnowledgeError('store', 'cannot delete the active revision');
    }
    if (record.pins.size > 0) {
      throw new KnowledgeError('store', 'cannot delete a deployment-pinned revision');
    }
    await this.#pool.query('DELETE FROM knowledge_revisions WHERE revision_id = $1', [revisionId]);
  }

  async findByContentHash(
    scope: KnowledgeScope,
    componentName: string,
    contentHash: string,
  ): Promise<KnowledgeRevision | undefined> {
    const result = await this.#pool.query<RevisionRow>(
      `SELECT * FROM knowledge_revisions
       WHERE org = $1 AND app = $2 AND env = $3 AND component_name = $4 AND content_hash = $5`,
      [scope.org, scope.app, scope.env, componentName, contentHash],
    );
    return result.rows[0] === undefined ? undefined : this.toRevision(result.rows[0]);
  }

  async stageDocuments(revisionId: string, documents: readonly StagedDocument[]): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const revision = await client.query(
        'SELECT revision_id FROM knowledge_revisions WHERE revision_id = $1 FOR UPDATE',
        [revisionId],
      );
      if (revision.rows[0] === undefined) {
        await client.query('ROLLBACK');
        throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
      }
      await client.query('DELETE FROM knowledge_revision_documents WHERE revision_id = $1', [
        revisionId,
      ]);
      for (const document of documents) {
        const plaintext = Buffer.from(document.text, 'utf8');
        await client.query(
          `INSERT INTO knowledge_revision_documents (revision_id, path, ciphertext, bytes)
           VALUES ($1, $2, $3, $4)`,
          [
            revisionId,
            document.descriptor.path,
            await this.#codec.seal(plaintext),
            plaintext.length,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async documents(revisionId: string): Promise<readonly StagedDocument[]> {
    const revision = await this.#pool.query<RevisionRow>(
      'SELECT * FROM knowledge_revisions WHERE revision_id = $1',
      [revisionId],
    );
    const row = revision.rows[0];
    if (row === undefined) {
      throw new KnowledgeError('not-found', `revision ${revisionId} is not staged`);
    }
    const rows = await this.#pool.query<{ path: string; ciphertext: Buffer }>(
      'SELECT path, ciphertext FROM knowledge_revision_documents WHERE revision_id = $1',
      [revisionId],
    );
    const byPath = new Map(rows.rows.map((text) => [text.path, text.ciphertext]));
    if (byPath.size === 0 && row.documents.length > 0) {
      throw new KnowledgeError('store', `revision ${revisionId} has no staged document text`);
    }
    const documents: StagedDocument[] = [];
    for (const descriptor of row.documents) {
      const ciphertext = byPath.get(descriptor.path);
      if (ciphertext === undefined) {
        throw new KnowledgeError(
          'store',
          `revision ${revisionId} is missing text for ${descriptor.path}`,
        );
      }
      documents.push({ descriptor, text: (await this.#codec.open(ciphertext)).toString('utf8') });
    }
    return documents;
  }

  private rowScope(row: RevisionRow): KnowledgeScope {
    return { org: row.org, app: row.app, env: row.env };
  }

  private toRevision(row: RevisionRow): KnowledgeRevision {
    return {
      revisionId: row.revision_id,
      scope: this.rowScope(row),
      componentName: row.component_name,
      documents: row.documents,
    };
  }
}

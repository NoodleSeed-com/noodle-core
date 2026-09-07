import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresKnowledgeRevisionStore } from '../src/postgres-revision-store.js';
import { describeRevisionStore } from './revision-store-parity.js';

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

const conditional = describe.skipIf(databaseUrl === undefined);

const pool = databaseUrl === undefined ? undefined : new Pool({ connectionString: databaseUrl });

afterAll(async () => {
  await pool?.end();
});

conditional('postgres knowledge revision store', () => {
  describeRevisionStore(
    async (codec) => {
      if (pool === undefined) throw new Error('DATABASE_URL suite ran without a pool');
      const store = new PostgresKnowledgeRevisionStore(pool, codec);
      // Parity runs against the runbook's throwaway database; a shared production database
      // would migrate via the service's ownership instead.
      await store.ensureSchema();
      // Each in-memory store starts empty, so the durable store must start empty too or the
      // two implementations are answering store-wide questions — `collectGarbage()` counts
      // every unreferenced revision it holds — over different universes, and the parity
      // suite compares results that were never comparable.
      await pool.query(
        'TRUNCATE knowledge_revisions, knowledge_revision_documents, knowledge_deployment_pins, knowledge_publication_leases',
      );
      return store;
    },
    `pg-${Math.random().toString(36).slice(2, 8)}`,
  );

  it('stores document text sealed at rest, not as plaintext', async () => {
    if (pool === undefined) throw new Error('DATABASE_URL suite ran without a pool');
    const xor = (buffer: Buffer): Buffer => Buffer.from([...buffer].map((byte) => byte ^ 0x5a));
    const store = new PostgresKnowledgeRevisionStore(pool, { seal: xor, open: xor });
    await store.ensureSchema();
    await pool.query(
      'TRUNCATE knowledge_revisions, knowledge_revision_documents, knowledge_deployment_pins, knowledge_publication_leases',
    );
    const scope = { org: 'acme', app: 'app', env: 'prod' } as const;
    const descriptor = {
      path: 'sealed.md',
      title: 'Sealed',
      sha256: 'a'.repeat(64),
      bytes: 6,
    } as const;
    await store.stage({
      scope,
      componentName: 'product',
      contentHash: 'sealed-hash',
      revision: {
        revisionId: 'sealed-rev',
        scope,
        componentName: 'product',
        documents: [descriptor],
      },
    });
    await store.stageDocuments('sealed-rev', [{ descriptor, text: 'secret' }]);
    const raw = await pool.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM knowledge_revision_documents WHERE revision_id = $1',
      ['sealed-rev'],
    );
    expect(raw.rows[0]?.ciphertext.toString('utf8')).not.toContain('secret');
    const documents = await store.documents('sealed-rev');
    expect(documents[0]?.text).toBe('secret');
  });
});

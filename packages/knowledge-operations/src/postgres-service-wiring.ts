import { PostgresKnowledgeRevisionStore, PostgresSearchBudgetStore } from '@noodle-borg/knowledge';
import type { Pool } from 'pg';
import { type StringSecretBox, secretBoxDocumentCodec } from './codec.js';
import { PostgresCrawlStateStore } from './postgres-crawl-state.js';
import { PostgresKnowledgeStagingStore } from './postgres-staging-store.js';
import type { KnowledgeServiceStores } from './service-wiring.js';

/** Durable knowledge stores sharing the full service's Postgres pool and secret custody. */
export async function createPostgresKnowledgeStores(
  pool: Pool,
  secretBox?: StringSecretBox,
): Promise<KnowledgeServiceStores> {
  const codec = secretBox === undefined ? undefined : secretBoxDocumentCodec(secretBox);
  const staging = new PostgresKnowledgeStagingStore(pool);
  const revisionStore = new PostgresKnowledgeRevisionStore(pool, codec);
  const budgetStore = new PostgresSearchBudgetStore(pool);
  const crawlState = new PostgresCrawlStateStore(pool);
  await staging.ensureSchema();
  await revisionStore.ensureSchema();
  await budgetStore.ensureSchema();
  await crawlState.ensureSchema();
  return {
    staging,
    revisionStore,
    budgetStore,
    crawlState,
    ...(codec === undefined ? {} : { codec }),
  };
}

import { createHash, randomBytes } from 'node:crypto';
import type { SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import type { ConversationHistoryStore } from './conversation-history/contracts.js';
import { InMemoryConversationHistoryStore } from './conversation-history/memory-store.js';
import { PostgresConversationHistoryStore } from './conversation-history/postgres-store.js';
import {
  InMemoryOperationCoordinationStore,
  type OperationCoordinationStore,
} from './operation-coordination.js';
import { PostgresOperationCoordinationStore } from './operation-coordination-postgres.js';
import type { OperationEvidenceStore } from './operation-evidence.js';
import { InMemoryOperationEvidenceStore } from './operation-evidence-memory.js';
import { PostgresOperationEvidenceStore } from './operation-evidence-postgres.js';
import type { ServeServiceOptions } from './serve-options.js';

interface OperationStores {
  readonly evidence: OperationEvidenceStore;
  readonly coordination: OperationCoordinationStore;
  readonly history: ConversationHistoryStore;
}

/** The existing explicit non-PostgreSQL local composition. Never used after a PostgreSQL failure. */
export function createLocalOperationStores(): OperationStores {
  return {
    evidence: new InMemoryOperationEvidenceStore(),
    coordination: new InMemoryOperationCoordinationStore(),
    history: new InMemoryConversationHistoryStore(),
  };
}

/** Bootstrap operational and conversation history with coordination; any schema failure stops startup. */
export async function createPostgresOperationStores(
  pool: Pool,
  secretBox: SecretBox,
): Promise<OperationStores> {
  const evidence = new PostgresOperationEvidenceStore(pool, secretBox);
  await evidence.ensureSchema();
  const coordination = new PostgresOperationCoordinationStore(pool, secretBox);
  await coordination.ensureSchema();
  const history = new PostgresConversationHistoryStore(pool, secretBox);
  await history.ensureSchema();
  return { evidence, coordination, history };
}

/** Durable operation evidence for the handler; absent when business information is disabled. */
export function createOperationEvidenceOptions(
  options: ServeServiceOptions,
  operationStores: OperationStores,
  operationEvidenceEpoch: string,
  businessInformationEnabled: boolean,
) {
  return businessInformationEnabled
    ? {
        store: operationStores.evidence,
        coordination: operationStores.coordination,
        epoch: operationEvidenceEpoch,
        identityKey: createHash('sha256')
          .update('operation-evidence\0')
          .update(
            options.operationEvidenceIdentityKey ??
              options.businessInformationSourceIdentityKey ??
              options.secretMasterKey ??
              randomBytes(32),
          )
          .digest('hex'),
        ...(options.clock === undefined
          ? {}
          : { now: () => options.clock?.().getTime() ?? Date.now() }),
      }
    : undefined;
}

/**
 * Conversation history composition (ADR 0241). Capture stays off: no business has opted in yet, so the
 * policy is always absent and only the operator API and retention sweep see the store.
 */
export function createConversationHistoryOptions(
  options: ServeServiceOptions,
  operationStores: OperationStores,
  businessInformationEnabled: boolean,
): ServeServiceOptions['conversationHistory'] {
  if (options.conversationHistory !== undefined) return options.conversationHistory;
  if (!businessInformationEnabled) return undefined;
  return {
    store: operationStores.history,
    policy: async () => undefined,
    identityKey: createHash('sha256')
      .update('conversation-history\0')
      .update(
        options.operationEvidenceIdentityKey ??
          options.businessInformationSourceIdentityKey ??
          options.secretMasterKey ??
          randomBytes(32),
      )
      .digest('hex'),
  };
}

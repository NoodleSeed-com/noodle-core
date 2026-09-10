import type { SecretBox } from '@noodle-borg/runtime';
import type { Pool } from 'pg';
import {
  InMemoryOperationCoordinationStore,
  type OperationCoordinationStore,
} from './operation-coordination.js';
import { PostgresOperationCoordinationStore } from './operation-coordination-postgres.js';
import type { OperationEvidenceStore } from './operation-evidence.js';
import { InMemoryOperationEvidenceStore } from './operation-evidence-memory.js';
import { PostgresOperationEvidenceStore } from './operation-evidence-postgres.js';

interface OperationStores {
  readonly evidence: OperationEvidenceStore;
  readonly coordination: OperationCoordinationStore;
}

/** The existing explicit non-PostgreSQL local composition. Never used after a PostgreSQL failure. */
export function createLocalOperationStores(): OperationStores {
  return {
    evidence: new InMemoryOperationEvidenceStore(),
    coordination: new InMemoryOperationCoordinationStore(),
  };
}

/** Bootstrap operational history and coordination together; either schema failure stops startup. */
export async function createPostgresOperationStores(
  pool: Pool,
  secretBox: SecretBox,
): Promise<OperationStores> {
  const evidence = new PostgresOperationEvidenceStore(pool, secretBox);
  await evidence.ensureSchema();
  const coordination = new PostgresOperationCoordinationStore(pool, secretBox);
  await coordination.ensureSchema();
  return { evidence, coordination };
}

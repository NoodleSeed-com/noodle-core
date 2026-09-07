import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe } from 'vitest';
import type { AssistantStore, TenantRef } from '../src/index.js';
import { InMemoryAssistantStore, PostgresAssistantStore } from '../src/index.js';
import { describeSessionTurns, PARITY_TENANT } from './session-turn-parity.js';

const now = new Date('2030-01-01T00:00:00Z');

async function seedSession(store: AssistantStore, tenant: TenantRef): Promise<string> {
  const created = await store.createClient({
    name: `web-${randomUUID()}`,
    tenant,
    deploymentId: 'dep_1',
    allowedOrigins: ['https://www.acme.test'],
    now,
  });
  const { session } = await store.createSession({
    clientId: created.client.id,
    tenant,
    deploymentId: 'dep_1',
    origin: 'https://www.acme.test',
    caller: { subject: `anon_${randomUUID()}`, identityKind: 'anonymous' },
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + 120_000).toISOString(),
  });
  return session.id;
}

describe('assistant session turn budget', () => {
  describeSessionTurns('in-memory', async () => {
    const store = new InMemoryAssistantStore();
    const tenant = PARITY_TENANT(`assistant-${randomUUID()}`);
    return { store, newSessionId: () => seedSession(store, tenant) };
  });

  const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    afterAll(async () => pool.end());
    describeSessionTurns('postgres', async () => {
      const store = new PostgresAssistantStore(pool);
      await store.ensureSchema();
      const tenant = PARITY_TENANT(`assistant-${randomUUID()}`);
      return { store, newSessionId: () => seedSession(store, tenant) };
    });
  }
});

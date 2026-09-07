import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe } from 'vitest';
import type { AssistantStore, TenantRef } from '../src/index.js';
import { InMemoryAssistantStore, PostgresAssistantStore } from '../src/index.js';
import { describeSessionElevation } from './session-elevation-parity.js';

const now = new Date('2030-01-01T00:00:00Z');

async function seedAnonymousSession(
  store: AssistantStore,
  tenant: TenantRef,
): Promise<{ readonly id: string; readonly token: string }> {
  const created = await store.createClient({
    name: `web-${randomUUID()}`,
    tenant,
    deploymentId: 'dep_1',
    allowedOrigins: ['https://www.acme.test'],
    now,
  });
  const { session, token } = await store.createSession({
    clientId: created.client.id,
    tenant,
    deploymentId: 'dep_1',
    origin: 'https://www.acme.test',
    caller: { subject: `anon_${randomUUID()}`, identityKind: 'anonymous' },
    publicEmbedId: 'pub_parity000000000000000',
    boundSurface: 'public',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 600_000).toISOString(),
    absoluteExpiresAt: new Date(now.getTime() + 1_200_000).toISOString(),
  });
  return { id: session.id, token };
}

describe('assistant session elevation', () => {
  describeSessionElevation('in-memory', async () => {
    const store = new InMemoryAssistantStore();
    const tenant = { org: `elev-${randomUUID()}`, app: 'site', env: 'prod' };
    return { store, newSession: () => seedAnonymousSession(store, tenant) };
  });

  const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    afterAll(async () => pool.end());
    describeSessionElevation('postgres', async () => {
      const store = new PostgresAssistantStore(pool);
      await store.ensureSchema();
      const tenant = { org: `elev-${randomUUID()}`, app: 'site', env: 'prod' };
      return { store, newSession: () => seedAnonymousSession(store, tenant) };
    });
  }
});

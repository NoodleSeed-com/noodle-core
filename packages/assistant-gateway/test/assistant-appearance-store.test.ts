import pg from 'pg';
import { afterAll, beforeAll, describe } from 'vitest';
import { InMemoryAssistantAppearanceSettingsStore } from '../src/in-memory-assistant-appearance-store.js';
import { PostgresAssistantAppearanceSettingsStore } from '../src/postgres-assistant-appearance-store.js';
import { describeAssistantAppearanceSettingsStore } from './assistant-appearance-store-suite.js';

describe('in-memory assistant appearance settings', () => {
  describeAssistantAppearanceSettingsStore(
    async () => new InMemoryAssistantAppearanceSettingsStore(),
  );
});

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

describePostgres('Postgres assistant appearance settings', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const store = new PostgresAssistantAppearanceSettingsStore(pool);

  beforeAll(async () => {
    await store.ensureSchema();
    await store.ensureSchema();
  });
  afterAll(async () => pool.end());

  describeAssistantAppearanceSettingsStore(async () => store);
});

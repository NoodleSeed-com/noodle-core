import { randomUUID } from 'node:crypto';
import type { DailyCounterStore } from '@noodle-borg/admission-limits';
import type {
  AssistantAppearanceSettingsStore,
  AssistantElevationStore,
  AssistantStore,
  PublicEmbedStore,
} from '@noodle-borg/assistant-gateway';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assistantStoreOptions,
  createPostgresAssistantStores,
} from '../src/serve-assistant-stores.js';

const URL = process.env.DATABASE_URL_TEST;
const SCHEMA = `serve_assistant_stores_test_${process.pid}`;

/** A pool that proves the factory never touches Postgres when every store is supplied. */
function poisonPool(): Pool {
  return new Proxy({} as Pool, {
    get(_target, property) {
      throw new Error(`unexpected pool access: ${String(property)}`);
    },
  });
}

const fakeAssistantStore = { kind: 'assistant' } as unknown as AssistantStore;
const fakeAppearance = { kind: 'appearance' } as unknown as AssistantAppearanceSettingsStore;
const fakePublicEmbeds = { kind: 'embeds' } as unknown as PublicEmbedStore;
const fakeCounters = { kind: 'counters' } as unknown as DailyCounterStore;
const fakeElevations = { kind: 'elevations' } as unknown as AssistantElevationStore;

describe('createPostgresAssistantStores', () => {
  it('keeps every supplied store (including elevations) without touching the pool', async () => {
    const set = await createPostgresAssistantStores(poisonPool(), {
      assistantStore: fakeAssistantStore,
      assistantAppearance: fakeAppearance,
      publicEmbeds: fakePublicEmbeds,
      admissionCounters: fakeCounters,
      elevations: fakeElevations,
    });
    expect(set.assistantStore).toBe(fakeAssistantStore);
    expect(set.assistantAppearance).toBe(fakeAppearance);
    expect(set.publicEmbeds).toBe(fakePublicEmbeds);
    expect(set.admissionCounters).toBe(fakeCounters);
    expect(set.elevations).toBe(fakeElevations);
  });
});

describe('assistantStoreOptions', () => {
  it('passes a supplied elevation store through to service options', () => {
    const options = assistantStoreOptions({ elevations: fakeElevations });
    expect(options.elevations).toBe(fakeElevations);
  });

  it('passes a supplied appearance store through to service options', () => {
    const options = assistantStoreOptions({ assistantAppearance: fakeAppearance });
    expect(options.assistantAppearance).toBe(fakeAppearance);
  });

  it('omits absent stores rather than passing undefined', () => {
    expect(Object.keys(assistantStoreOptions({}))).toEqual([]);
  });
});

describe.skipIf(!URL)('createPostgresAssistantStores (Postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pool = new Pool({
      connectionString: URL,
      options: `-c search_path=${SCHEMA}`,
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('builds a durable elevation store when none is supplied (hosted sign-in depends on it)', async () => {
    const set = await createPostgresAssistantStores(pool, {});
    const now = new Date();
    const requested = await set.elevations.request({
      sessionId: randomUUID(),
      tenant: { org: 'o', app: 'a', env: 'prod' },
      tool: 'time_off_balance',
      now,
    });
    expect(requested.continuation).toBeTruthy();
    expect(requested.elevation.tool).toBe('time_off_balance');
  });
});

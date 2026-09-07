import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { counterRow } from '@noodle-borg/admission-limits/portable';
import { PostgresDailyCounterStore } from '@noodle-borg/admission-limits/postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  admitBusinessTarget,
  authorizeBusinessApi,
  businessApiCounter,
} from '../src/business-api-admission.js';

const databaseUrl = process.env.DATABASE_URL_TEST;
describe.skipIf(!databaseUrl)('business HTTP admission with shared PostgreSQL counters', () => {
  const schema = `business_admission_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  const first = new PostgresDailyCounterStore(pool),
    second = new PostgresDailyCounterStore(pool);
  let now = new Date('2026-09-07T10:20:15Z');
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await first.ensureSchema();
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  async function call(store: PostgresDailyCounterStore, subject: string) {
    const req = new IncomingMessage(new Socket());
    req.method = 'PATCH';
    req.url = '/v1/orgs/acme/solution-installations/install/settings';
    const res = new ServerResponse(req);
    const identity = await authorizeBusinessApi(req, res, {
      publicCounters: store,
      now: () => now,
      gate: {
        authorize: async () => ({
          ok: true,
          identity: { subject, email: `${subject}@example.test`, superAdmin: false },
        }),
      },
    });
    return {
      res,
      allowed:
        identity !== false &&
        (await admitBusinessTarget(res, { org: 'acme', installationId: 'install' })),
    };
  }
  it('atomically shares target admission across two instances at max:1 and resets at the real minute boundary', async () => {
    const installation = businessApiCounter('mutation', 'installation', ['acme', 'install']);
    const org = businessApiCounter('mutation', 'org', 'acme');
    await first.consume({ ...installation, amount: installation.limit - 1 }, now);
    const results = await Promise.all([call(first, 'one'), call(second, 'two')]);
    expect(results.map((r) => r.allowed).sort()).toEqual([false, true]);
    expect(results.find((r) => !r.allowed)?.res.statusCode).toBe(429);
    expect(await first.peek(counterRow(installation, now).key, now)).toBe(installation.limit);
    expect(await first.peek(counterRow(org, now).key, now)).toBe(1);
    expect((await call(second, 'three')).allowed).toBe(false);
    now = new Date('2026-09-07T10:21:00Z');
    expect((await call(second, 'three')).allowed).toBe(true);
    expect(await first.peek(counterRow(installation, now).key, now)).toBe(1);
    expect(
      await pool
        .query('SELECT count(*)::int AS count FROM admission_counter_receipts')
        .then((r) => r.rows[0].count),
    ).toBe(0);
  });
});

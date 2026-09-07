import { randomUUID } from 'node:crypto';
import {
  ADMISSION_DEFAULTS,
  PostgresDailyCounterStore,
  visitorBucket,
} from '@noodle-borg/admission-limits';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryPublicEmbedStore } from '../src/in-memory-embed-store.js';
import { mintPublicSession } from '../src/public-session.js';

/**
 * The rehearsal this system never had: NAT-shaped traffic through the real counters.
 *
 * Every admission property below has been argued from the code and asserted against the in-memory
 * store, which is exactly the position the per-address tier was in when it took production down — the
 * shared suite exercised only the daily window, and the routes used a mocked counter, so no test ever
 * put the real shape through real SQL. This one does: hundreds of people behind one office address,
 * and one machine cycling identifiers, against `PostgresDailyCounterStore` at the shipped defaults.
 *
 * Skips without `DATABASE_URL`; the throwaway local Postgres runbook lives with the repository's
 * scripts. Named in prose rather than as a quoted path on purpose: this file is projected into the
 * public Core tree, that runbook is not, and a quoted path to something the projection omits is a
 * dangling reference for the first contributor who follows it.
 */

const databaseUrl = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
const describePostgres = describe.skipIf(databaseUrl === undefined);

const ORIGIN = 'https://www.acme.test';
const NOW = new Date('2030-06-01T09:00:00Z');

describePostgres('a busy office behind one address', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const counters = new PostgresDailyCounterStore(pool);
  const embeds = new InMemoryPublicEmbedStore();

  beforeAll(async () => counters.ensureSchema());
  afterAll(async () => pool.end());

  async function surface() {
    const embed = await embeds.ensure({
      org: `scale-${randomUUID()}`,
      app: 'site',
      env: 'prod',
      surfaceMode: 'public',
      now: NOW,
    });
    return {
      embed,
      mint: (visitorId: string | undefined, addressBucket: string) =>
        mintPublicSession(
          { embedId: embed.embedId, origin: ORIGIN, addressBucket, visitorId },
          ADMISSION_DEFAULTS,
          {
            embeds,
            counters,
            resolveActiveSurface: async () => ({
              mode: 'public' as const,
              origins: [ORIGIN],
              capabilities: [],
            }),
            createSession: async () => ({ token: 'nss_x', expiresAt: NOW.toISOString() }),
            newAnonymousSubject: () => 'anon',
            now: () => NOW,
          },
        ),
    };
  }

  it('serves two hundred colleagues sharing one address, at the shipped defaults', async () => {
    const { mint } = await surface();
    const address = `ip_${randomUUID().replaceAll('-', '')}`;

    // Two hundred distinct people, one office NAT, no configuration. Under the address tier alone
    // this is the eleventh person onward being told the assistant is unavailable.
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, index) => mint(`visitor-${index}`, address)),
    );

    expect(results.filter((result) => !result.ok)).toEqual([]);
  });

  it('bounds one machine cycling identifiers, because the address it comes from does not cycle', async () => {
    const { mint } = await surface();
    const address = `ip_${randomUUID().replaceAll('-', '')}`;
    const attempts = ADMISSION_DEFAULTS.mintsPerAddressHour + 25;

    // Sequential on purpose: an abuser's requests race each other, and the guarantee is that the
    // atomic consume admits exactly the ceiling however they interleave.
    const codes: string[] = [];
    for (let index = 0; index < attempts; index += 1) {
      const result = await mint(`rotating-${randomUUID()}`, address);
      if (!result.ok) codes.push(result.code);
    }

    expect(codes).toHaveLength(25);
    // Never its own visitor ceiling — a fresh identifier never meets one — always the address bound.
    expect(new Set(codes)).toEqual(new Set(['address_session_budget_exhausted']));
  });

  it('never lets concurrent requests collectively exceed a ceiling', async () => {
    const { mint } = await surface();
    const address = `ip_${randomUUID().replaceAll('-', '')}`;
    const visitor = `visitor-${randomUUID()}`;
    const attempts = ADMISSION_DEFAULTS.mintsPerVisitorHour + 20;

    // All at once against one row: the single-statement consume is what makes this deterministic.
    const results = await Promise.all(
      Array.from({ length: attempts }, () => mint(visitor, address)),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(
      ADMISSION_DEFAULTS.mintsPerVisitorHour,
    );
  });

  it('keeps the visitor identifier out of the counter key', async () => {
    // The stored key is a digest; the browser's value never reaches the database. Minting first is
    // the whole test — querying an empty table proves nothing about how a key is written.
    const { mint } = await surface();
    const raw = 'visitor@example.com';
    const bucket = visitorBucket(raw);
    expect(bucket).not.toContain('example');
    expect((await mint(raw, `ip_${randomUUID().replaceAll('-', '')}`)).ok).toBe(true);

    const digested = await pool.query<{ counter_key: string }>(
      'SELECT counter_key FROM admission_daily_counters WHERE counter_key LIKE $1',
      [`%${bucket ?? 'no-bucket'}%`],
    );
    expect(digested.rows.length).toBeGreaterThan(0);

    const leaked = await pool.query<{ counter_key: string }>(
      'SELECT counter_key FROM admission_daily_counters WHERE counter_key LIKE $1',
      ['%example%'],
    );
    expect(leaked.rows).toEqual([]);
  });
});

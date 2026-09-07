import {
  ADMISSION_DEFAULTS,
  clamp,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits';
import { describe, expect, it, vi } from 'vitest';
import type { PublicEmbedRecord } from '../src/embed-store.js';
import { InMemoryPublicEmbedStore } from '../src/in-memory-embed-store.js';
import {
  mintPublicSession,
  type PublicSessionPorts,
  type PublicSurface,
} from '../src/public-session.js';

const now = new Date('2030-08-01T12:00:00Z');
const ORIGIN = 'https://www.acme.test';

/** A durable stand-in: the real durability guarantee is proven in the counter store's own parity suite. */
class DurableCounters extends InMemoryDailyCounterStore {
  override readonly durable = true;
}

async function harness(
  overrides: {
    readonly counters?: PublicSessionPorts['counters'];
    readonly surface?: PublicSurface | undefined;
    readonly createSession?: PublicSessionPorts['createSession'];
    readonly resolveBudgetBounds?: PublicSessionPorts['resolveBudgetBounds'];
  } = {},
) {
  const embeds = new InMemoryPublicEmbedStore();
  const embed = await embeds.ensure({
    org: 'acme',
    app: 'site',
    env: 'prod',
    surfaceMode: 'public',
    now,
  });
  const createSession =
    overrides.createSession ??
    vi.fn(async () => ({ token: 'tok_1', expiresAt: '2030-08-01T12:30:00Z' }));
  const ports: PublicSessionPorts = {
    embeds,
    counters: overrides.counters ?? new DurableCounters(),
    resolveActiveSurface: async () =>
      'surface' in overrides
        ? overrides.surface
        : { mode: 'public', origins: [ORIGIN], capabilities: [] },
    ...(overrides.resolveBudgetBounds === undefined
      ? {}
      : { resolveBudgetBounds: overrides.resolveBudgetBounds }),
    createSession,
    newAnonymousSubject: () => 'anon_subject_1',
    now: () => now,
  };
  return { embed, embeds, ports, createSession };
}

const mint = async (
  ports: PublicSessionPorts,
  request: { embedId?: unknown; origin?: unknown },
  envelope = ADMISSION_DEFAULTS,
) => mintPublicSession({ embedId: request.embedId, origin: request.origin }, envelope, ports);

describe('public session mint', () => {
  it('mints an anonymous session for a live embed on an allowed origin', async () => {
    const { embed, ports, createSession } = await harness();
    const result = await mint(ports, { embedId: embed.embedId, origin: ORIGIN });

    expect(result).toMatchObject({ ok: true, token: 'tok_1' });
    // The caller identity is server-minted and opaque; nothing from the request becomes a subject.
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'anon_subject_1', origin: ORIGIN }),
    );
  });

  it('applies an enrolled sponsored envelope when creating the public session', async () => {
    const { embed, ports, createSession } = await harness({
      resolveBudgetBounds: async () => ({
        defaults: { turnsPerSession: 40, turnsPerDay: 5_000, mintsPerDay: 1_000 },
        ceiling: { turnsPerDay: 5_000, mintsPerDay: 1_000 },
      }),
    });
    expect(await mint(ports, { embedId: embed.embedId, origin: ORIGIN })).toMatchObject({
      ok: true,
    });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        envelope: expect.objectContaining({
          turnsPerSession: 40,
          turnsPerDay: 5_000,
          mintsPerDay: 1_000,
        }),
      }),
    );
  });

  it.each([
    ['a missing embed id', { origin: ORIGIN }, 400],
    ['a credential-shaped embed id', { embedId: 'sk_live_x', origin: ORIGIN }, 400],
    ['a missing origin', { embedId: 'pub_aaaaaaaaaaaaaaaaaaaaaaaa' }, 403],
  ])('refuses %s', async (_label, request, status) => {
    const { ports } = await harness();
    expect(await mint(ports, request)).toMatchObject({ ok: false, status });
  });

  it('refuses an unknown embed with 403 rather than 404', async () => {
    const { ports } = await harness();
    const result = await mint(ports, {
      embedId: 'pub_bbbbbbbbbbbbbbbbbbbbbbbb',
      origin: ORIGIN,
    });
    // 404 would turn the endpoint into an oracle for which ids exist.
    expect(result).toMatchObject({ ok: false, status: 403, code: 'embed_not_found' });
  });

  it('refuses an origin outside the live surface', async () => {
    const { embed, ports } = await harness();
    const result = await mint(ports, { embedId: embed.embedId, origin: 'https://evil.test' });
    expect(result).toMatchObject({ ok: false, status: 403, code: 'origin_not_allowed' });
  });

  it('refuses when no active deployment carries the surface', async () => {
    const { embed, ports } = await harness({ surface: undefined });
    expect(await mint(ports, { embedId: embed.embedId, origin: ORIGIN })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  /**
   * The structural form of ADR 0201's "durable across service instances". A per-process counter would
   * reset a customer's spend ceiling on every restart and scale-out, so the surface must not serve at
   * all rather than serve with a ceiling that silently is not one.
   */
  it('refuses to mint at all when the counter store is not durable', async () => {
    const { embed, ports, createSession } = await harness({
      counters: new InMemoryDailyCounterStore(),
    });
    const result = await mint(ports, { embedId: embed.embedId, origin: ORIGIN });

    expect(result).toMatchObject({ ok: false, status: 503, code: 'admission_store_not_durable' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('stops minting when the daily session budget is spent', async () => {
    const { embed, ports, createSession } = await harness();
    const envelope = clamp({ mintsPerDay: 2 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await mint(ports, { embedId: embed.embedId, origin: ORIGIN }, envelope)).toMatchObject(
        {
          ok: true,
        },
      );
    }
    const spent = await mint(ports, { embedId: embed.embedId, origin: ORIGIN }, envelope);

    expect(spent).toMatchObject({ ok: false, status: 429, code: 'daily_session_budget_exhausted' });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('serves nobody when the budget is switched off', async () => {
    const { embed, ports, createSession } = await harness();
    const result = await mint(
      ports,
      { embedId: embed.embedId, origin: ORIGIN },
      clamp({ mintsPerDay: 0 }),
    );
    // Zero is the kill switch; it must read as "unavailable", not as a broken embed.
    expect(result).toMatchObject({ ok: false, status: 429 });
    expect(createSession).not.toHaveBeenCalled();
  });

  /** Every refusal path must cost nothing: no session row, no deployment read that could spend. */
  it('never creates a session on any refusal', async () => {
    const cases: { embedId?: unknown; origin?: unknown }[] = [
      { origin: ORIGIN },
      { embedId: 'pub_cccccccccccccccccccccccc', origin: ORIGIN },
      { embedId: 'sk_live_x', origin: ORIGIN },
    ];
    for (const request of cases) {
      const { createSession, ports } = await harness();
      const result = await mint(ports, request);
      expect(result.ok).toBe(false);
      expect(createSession).not.toHaveBeenCalled();
    }
  });

  it('refuses a revoked embed', async () => {
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({
      org: 'acme',
      app: 'site',
      env: 'prod',
      surfaceMode: 'public',
      now,
    });
    await embeds.revoke(embed.embedId, now);
    const { ports } = await harness();
    const result = await mintPublicSession(
      { embedId: embed.embedId, origin: ORIGIN },
      ADMISSION_DEFAULTS,
      { ...ports, embeds },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('carries the surface mode through so a mixed surface can offer sign-in', async () => {
    const { embed, ports } = await harness();
    const result = await mint(ports, { embedId: embed.embedId, origin: ORIGIN });
    expect(result.ok && (result.embed as PublicEmbedRecord).surfaceMode).toBe('public');
  });
});

describe('a surface’s own mint budget', () => {
  it('refuses a mint once the operator’s lower cap is spent', async () => {
    const { embed, embeds, ports } = await harness();
    await embeds.setBudget(embed.embedId, { mintsPerDay: 1 }, now);

    expect((await mint(ports, { embedId: embed.embedId, origin: ORIGIN })).ok).toBe(true);
    expect(await mint(ports, { embedId: embed.embedId, origin: ORIGIN })).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_session_budget_exhausted',
    });
  });

  /**
   * The kill switch has to close both doors. Stopping turns while still handing out fresh sessions
   * would leave a bot writing durable session rows against a surface an operator switched off.
   */
  it('mints nothing at all when the cap is zero', async () => {
    const { embed, embeds, ports, createSession } = await harness();
    await embeds.setBudget(embed.embedId, { mintsPerDay: 0 }, now);

    expect(await mint(ports, { embedId: embed.embedId, origin: ORIGIN })).toMatchObject({
      ok: false,
      code: 'daily_session_budget_exhausted',
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('gives the minted session the surface’s resolved envelope, not the raw default', async () => {
    const { embed, embeds, ports, createSession } = await harness();
    await embeds.setBudget(embed.embedId, { turnsPerDay: 7 }, now);
    await mint(ports, { embedId: embed.embedId, origin: ORIGIN });

    expect(vi.mocked(createSession).mock.calls[0]?.[0].envelope.turnsPerDay).toBe(7);
  });
});

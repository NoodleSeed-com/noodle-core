import { ADMISSION_DEFAULTS, ADMISSION_MAXIMUM } from '@noodle-borg/admission-limits';
import { describe, expect, it, vi } from 'vitest';
import {
  admitPublicTurn,
  InMemoryPublicEmbedStore,
  mintPublicSession,
  surfaceEnvelope,
} from '../src/index.js';

/**
 * Admission tier 3 at the decision, where its ordering relative to tier 2 is the contract.
 *
 * The two tiers answer different questions — the surface cap governs the customer's **solvency**, this
 * governs **fairness between visitors** — and the order matters because refusals are not free: if one
 * visitor's rejected mint still spent the surface's daily budget, an abuser would exhaust the
 * customer's day on requests that were never served.
 */

const TENANT = { org: 'acme', app: 'site', env: 'prod' } as const;
const NOW = new Date('2030-01-01T00:00:00.000Z');

async function open(envelope = ADMISSION_DEFAULTS) {
  const embeds = new InMemoryPublicEmbedStore();
  const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
  const spent = new Map<string, number>();
  const counters = {
    durable: true,
    consume: vi.fn(async ({ key, limit }: { key: string; limit: number }) => {
      const next = (spent.get(key) ?? 0) + 1;
      if (next > limit) return { allowed: false, used: spent.get(key) ?? 0, limit, resetAt: NOW };
      spent.set(key, next);
      return { allowed: true, used: next, limit, resetAt: NOW };
    }),
    peek: async (key: string) => spent.get(key) ?? 0,
  };
  const ports = {
    embeds,
    counters,
    resolveActiveSurface: async () => ({
      mode: 'public' as const,
      origins: ['https://www.acme.test'],
      capabilities: [],
    }),
    createSession: async () => ({ token: 'nss_x', expiresAt: NOW.toISOString() }),
    newAnonymousSubject: () => 'anon_1',
    now: () => NOW,
  };
  const mint = (addressBucket?: string, visitorId?: string) =>
    mintPublicSession(
      { embedId: embed.embedId, origin: 'https://www.acme.test', addressBucket, visitorId },
      envelope,
      ports as never,
    );
  return { mint, counters, spent, embed };
}

describe('per-address admission', () => {
  it('lets one visitor through up to the hourly ceiling and refuses the next', async () => {
    const { mint } = await open({ ...ADMISSION_DEFAULTS, mintsPerAddressHour: 2 });

    expect((await mint('ip_aaa')).ok).toBe(true);
    expect((await mint('ip_aaa')).ok).toBe(true);
    const refused = await mint('ip_aaa');
    expect(refused).toMatchObject({ ok: false, code: 'address_session_budget_exhausted' });
  });

  it('does not spend the surface day on a visitor it refused', async () => {
    const { mint, spent, embed } = await open({ ...ADMISSION_DEFAULTS, mintsPerAddressHour: 1 });

    await mint('ip_aaa');
    await mint('ip_aaa');

    // One accepted mint, so one unit of the customer's daily budget. The refusal cost them nothing,
    // which is the entire reason this tier is checked first.
    expect(spent.get(`mints:${embed.embedId}`)).toBe(1);
  });

  it('keeps visitors independent of each other', async () => {
    const { mint } = await open({ ...ADMISSION_DEFAULTS, mintsPerAddressHour: 1 });

    expect((await mint('ip_aaa')).ok).toBe(true);
    // A second visitor is unaffected by the first having spent their own allowance.
    expect((await mint('ip_bbb')).ok).toBe(true);
    expect((await mint('ip_aaa')).ok).toBe(false);
  });

  it('falls back to the surface tier when ingress could not be parsed', async () => {
    const { mint, counters } = await open({ ...ADMISSION_DEFAULTS, mintsPerAddressHour: 0 });

    // No bucket: unknown ingress must not become one shared bucket, which would be both a free-for-all
    // and a shared throttle. Losing this tier loses fairness and never solvency.
    expect((await mint(undefined)).ok).toBe(true);
    const keys = counters.consume.mock.calls.map(([request]) => (request as { key: string }).key);
    expect(keys.some((key) => key.includes(':addr:'))).toBe(false);
  });

  it('counts an address against the surface it arrived through, not globally', async () => {
    const { mint, counters, embed } = await open();
    await mint('ip_aaa');
    const keys = counters.consume.mock.calls.map(([request]) => (request as { key: string }).key);
    // Two customers sharing a visitor must not share their throttle.
    expect(keys).toContain(`mints:addr:${embed.embedId}:ip_aaa`);
  });

  it('uses an hourly window, not the daily one', async () => {
    const { mint, counters } = await open();
    await mint('ip_aaa');
    const perAddress = counters.consume.mock.calls
      .map(([request]) => request as { key: string; window?: string })
      .find((request) => request.key.includes(':addr:'));
    expect(perAddress?.window).toBe('hour');
  });
});

describe('per-address turn admission', () => {
  it("bounds one visitor's turns per hour without spending the session or the surface day", async () => {
    const { embed, ports, spent } = await openTurns({
      ...ADMISSION_DEFAULTS,
      turnsPerAddressHour: 2,
    });
    const turn = (addressBucket?: string) =>
      admitPublicTurn(
        { sessionId: 'sess_1', publicEmbedId: embed.embedId, message: 'hi', addressBucket },
        { ...ADMISSION_DEFAULTS, turnsPerAddressHour: 2 },
        ports as never,
      );

    expect((await turn('ip_aaa')).ok).toBe(true);
    expect((await turn('ip_aaa')).ok).toBe(true);
    expect(await turn('ip_aaa')).toMatchObject({
      ok: false,
      code: 'address_turn_budget_exhausted',
    });

    // Two served turns, so two units of the surface's day — the refusal cost the customer nothing,
    // and it cost the visitor's own session allowance nothing either.
    expect(spent.get(`turns:${embed.embedId}`)).toBe(2);
    expect(ports.consumeTurn).toHaveBeenCalledTimes(2);
  });

  it('keeps visitors independent and falls back when ingress is unparseable', async () => {
    const envelope = { ...ADMISSION_DEFAULTS, turnsPerAddressHour: 1 };
    const { embed, ports } = await openTurns(envelope);
    const turn = (addressBucket?: string) =>
      admitPublicTurn(
        { sessionId: 'sess_1', publicEmbedId: embed.embedId, message: 'hi', addressBucket },
        envelope,
        ports as never,
      );

    expect((await turn('ip_aaa')).ok).toBe(true);
    expect((await turn('ip_bbb')).ok).toBe(true);
    expect((await turn('ip_aaa')).ok).toBe(false);
    // No bucket: the surface tier alone applies rather than one shared throttle for unknown ingress.
    expect((await turn(undefined)).ok).toBe(true);
  });
});

async function openTurns(envelope: typeof ADMISSION_DEFAULTS) {
  const embeds = new InMemoryPublicEmbedStore();
  const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
  const spent = new Map<string, number>();
  const counters = {
    durable: true,
    consume: vi.fn(async ({ key, limit }: { key: string; limit: number }) => {
      const next = (spent.get(key) ?? 0) + 1;
      if (next > limit) return { allowed: false, used: spent.get(key) ?? 0, limit, resetAt: NOW };
      spent.set(key, next);
      return { allowed: true, used: next, limit, resetAt: NOW };
    }),
    peek: async (key: string) => spent.get(key) ?? 0,
  };
  const ports = {
    embeds,
    counters,
    consumeTurn: vi.fn(async () => ({ allowed: true, turnCount: 1 })),
    now: () => NOW,
  };
  return { embed, ports, spent, envelope };
}

describe('per-visitor admission', () => {
  /**
   * The case the address tier gets wrong, and the reason this tier exists.
   *
   * A corporate NAT, a university, or a mobile carrier's CGNAT puts hundreds of unrelated people
   * behind one address. Under the address tier alone the eleventh of them is refused — an outcome
   * indistinguishable from a broken product, and invisible to the operator.
   */
  it('gives each visitor behind one address their own allowance', async () => {
    const { mint } = await open({
      ...ADMISSION_DEFAULTS,
      mintsPerVisitorHour: 2,
      mintsPerAddressHour: 100,
    });

    expect((await mint('ip_office', 'vis_a')).ok).toBe(true);
    expect((await mint('ip_office', 'vis_a')).ok).toBe(true);
    expect(await mint('ip_office', 'vis_a')).toMatchObject({
      ok: false,
      code: 'visitor_session_budget_exhausted',
    });
    // Their colleague on the same address is unaffected, which is the whole point.
    expect((await mint('ip_office', 'vis_b')).ok).toBe(true);
    expect((await mint('ip_office', 'vis_c')).ok).toBe(true);
  });

  it('still bounds a visitor who rotates the identifier, because the address tier does not move', async () => {
    const { mint } = await open({
      ...ADMISSION_DEFAULTS,
      mintsPerVisitorHour: 50,
      mintsPerAddressHour: 2,
    });

    expect((await mint('ip_abuser', 'vis_1')).ok).toBe(true);
    expect((await mint('ip_abuser', 'vis_2')).ok).toBe(true);
    // A fresh identifier every time never meets its own ceiling; the address one is not rotatable.
    expect(await mint('ip_abuser', 'vis_3')).toMatchObject({
      ok: false,
      code: 'address_session_budget_exhausted',
    });
  });

  it('refuses a visitor before spending any of the shared address allowance', async () => {
    const { mint, spent, embed } = await open({
      ...ADMISSION_DEFAULTS,
      mintsPerVisitorHour: 1,
      mintsPerAddressHour: 100,
    });

    await mint('ip_office', 'vis_a');
    await mint('ip_office', 'vis_a');

    // One admitted mint, so one address unit — the refusal cost the address nothing.
    expect(spent.get(`mints:addr:${embed.embedId}:ip_office`)).toBe(1);
  });

  it('falls back to address-only fairness when the browser sends no identifier', async () => {
    const { mint, spent, embed } = await open({
      ...ADMISSION_DEFAULTS,
      mintsPerVisitorHour: 1,
      mintsPerAddressHour: 5,
    });

    expect((await mint('ip_plain')).ok).toBe(true);
    expect((await mint('ip_plain')).ok).toBe(true);
    // A lost tier, never a shared one: no visitor key is written at all.
    expect([...spent.keys()].some((key) => key.includes(':vis:'))).toBe(false);
    expect(spent.get(`mints:addr:${embed.embedId}:ip_plain`)).toBe(2);
  });
});

/**
 * D2, the reason the whole raise happened: the pilot's numbers made a customer who succeeded go
 * dark. A per-address bound also has to be reachable by the operator whose traffic shape it is —
 * a cap the service enforces and nobody can set is a cap nobody can operate.
 */
describe('web-scale defaults and operator overrides', () => {
  it('carries a busy site through a day at the shipped defaults', async () => {
    // Roughly a 100k-visitor site at ordinary engagement: 2,000 conversations, well inside the cap.
    expect(ADMISSION_DEFAULTS.mintsPerDay).toBeGreaterThanOrEqual(5_000);
    expect(ADMISSION_DEFAULTS.turnsPerDay).toBeGreaterThanOrEqual(20_000);
    // And a corporate NAT no longer meets the address bound with real people behind it.
    expect(ADMISSION_DEFAULTS.mintsPerAddressHour).toBeGreaterThanOrEqual(300);
  });

  it('honours an operator lowering the per-address bound, and refuses to raise it', async () => {
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
    const lowered = await embeds.setBudget(embed.embedId, { mintsPerAddressHour: 2 }, NOW);
    expect(surfaceEnvelope(ADMISSION_DEFAULTS, lowered as never).mintsPerAddressHour).toBe(2);

    const raised = await embeds.setBudget(
      embed.embedId,
      { mintsPerAddressHour: Number.MAX_SAFE_INTEGER },
      NOW,
    );
    // Clamped to the deployed default, not to the structural maximum. Stopping at the maximum would
    // still be a sixty-fold raise of the abuse bound, granted to the one party it exists to bound —
    // and it is not the operator's to spend, because the people it protects are behind someone
    // else's address.
    expect(surfaceEnvelope(ADMISSION_DEFAULTS, raised as never).mintsPerAddressHour).toBe(
      ADMISSION_DEFAULTS.mintsPerAddressHour,
    );
    expect(ADMISSION_DEFAULTS.mintsPerAddressHour).toBeLessThan(
      ADMISSION_MAXIMUM.mintsPerAddressHour,
    );

    const raisedTurns = await embeds.setBudget(
      embed.embedId,
      { turnsPerAddressHour: Number.MAX_SAFE_INTEGER },
      NOW,
    );
    expect(surfaceEnvelope(ADMISSION_DEFAULTS, raisedTurns as never).turnsPerAddressHour).toBe(
      ADMISSION_DEFAULTS.turnsPerAddressHour,
    );
  });

  it('leaves a cap alone when the operator did not mention it', async () => {
    const embeds = new InMemoryPublicEmbedStore();
    const embed = await embeds.ensure({ ...TENANT, surfaceMode: 'public', now: NOW });
    await embeds.setBudget(embed.embedId, { mintsPerAddressHour: 5 }, NOW);
    const after = await embeds.setBudget(embed.embedId, { turnsPerDay: 100 }, NOW);

    // Raising turns must not quietly clear an address ceiling someone set separately.
    expect(after?.mintsPerAddressHour).toBe(5);
  });
});

/**
 * The bridge budgets shipped platform-only: the envelope carried them, `surfaceEnvelope` did not read
 * them off the embed row, and `noodle assistant budget set` had no flag for them. An operator's only
 * two positions were the shipped default and the kill switch. These pin the override path that closes
 * that, and the shape the defaults now take relative to the assistant path beside them.
 */
describe("bridge budgets are the operator's to set", () => {
  const embed = (over: Record<string, number>) => ({
    turnsPerDay: undefined,
    mintsPerDay: undefined,
    mintsPerAddressHour: undefined,
    turnsPerAddressHour: undefined,
    bridgeToolCallsPerSession: undefined,
    bridgeToolCallsPerDay: undefined,
    ...over,
  });

  it('takes a surface override in either direction', () => {
    const raised = surfaceEnvelope(
      ADMISSION_DEFAULTS,
      embed({ bridgeToolCallsPerSession: 150, bridgeToolCallsPerDay: 90_000 }),
    );
    expect(raised.bridgeToolCallsPerSession).toBe(150);
    expect(raised.bridgeToolCallsPerDay).toBe(90_000);

    const lowered = surfaceEnvelope(ADMISSION_DEFAULTS, embed({ bridgeToolCallsPerDay: 10 }));
    expect(lowered.bridgeToolCallsPerDay).toBe(10);
    // Untouched caps keep the default rather than collapsing to the one that was set.
    expect(lowered.bridgeToolCallsPerSession).toBe(ADMISSION_DEFAULTS.bridgeToolCallsPerSession);
  });

  it('holds an over-eager override under the structural maximum', () => {
    // The operator's budget to spend, but not the platform's bound to move — same rule the daily
    // caps follow, so an operator cannot raise their way past what the runtime will serve.
    const envelope = surfaceEnvelope(
      ADMISSION_DEFAULTS,
      embed({ bridgeToolCallsPerSession: 999_999 }),
    );
    expect(envelope.bridgeToolCallsPerSession).toBe(ADMISSION_MAXIMUM.bridgeToolCallsPerSession);
  });

  it('keeps zero, because zero is the kill switch here too', () => {
    expect(
      surfaceEnvelope(ADMISSION_DEFAULTS, embed({ bridgeToolCallsPerDay: 0 }))
        .bridgeToolCallsPerDay,
    ).toBe(0);
  });

  it('sizes the default against the assistant path it sits beside', () => {
    // A session may already spend turnsPerSession x toolCallsPerTurn tool calls through the panel,
    // against the same connectors, and a bridge call runs no model. This does not claim a ratio —
    // nothing here is measured — only that the cheaper caller is not bounded an order of magnitude
    // tighter than the dearer one, which is the state these defaults were left in.
    const assistantToolCalls =
      ADMISSION_DEFAULTS.turnsPerSession * ADMISSION_DEFAULTS.toolCallsPerTurn;
    expect(ADMISSION_DEFAULTS.bridgeToolCallsPerSession * 4).toBeGreaterThanOrEqual(
      assistantToolCalls,
    );
    expect(ADMISSION_DEFAULTS.bridgeToolCallsPerDay).toBe(ADMISSION_DEFAULTS.turnsPerDay);
  });
});

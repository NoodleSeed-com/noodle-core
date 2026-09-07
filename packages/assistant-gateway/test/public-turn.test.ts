import {
  ADMISSION_DEFAULTS,
  ADMISSION_MAXIMUM,
  clamp,
  InMemoryDailyCounterStore,
} from '@noodle-borg/admission-limits';
import { describe, expect, it, vi } from 'vitest';
import type { PublicEmbedRecord } from '../src/embed-store.js';
import {
  admitBridgeToolCall,
  admitPublicTurn,
  type BridgeToolCallPorts,
  type PublicTurnPorts,
} from '../src/public-turn.js';

const now = new Date('2030-08-01T12:00:00Z');
const EMBED = 'pub_aaaaaaaaaaaaaaaaaaaaaaaa';

const embedRecord = (budget: Partial<PublicEmbedRecord> = {}): PublicEmbedRecord => ({
  embedId: EMBED,
  org: 'acme',
  app: 'site',
  env: 'prod',
  surfaceMode: 'public',
  createdAt: now,
  ...budget,
});

const embedsWith = (record: PublicEmbedRecord | undefined) => ({
  lookup: async () => record,
});

function harness(overrides: Partial<PublicTurnPorts> = {}) {
  const consumeTurn = vi.fn(async (_id: string, _limit: number) => ({
    allowed: true,
    turnCount: 1,
  }));
  const ports: PublicTurnPorts = {
    counters: new InMemoryDailyCounterStore(),
    embeds: embedsWith(embedRecord()),
    consumeTurn,
    now: () => now,
    ...overrides,
  };
  return { ports, consumeTurn: ports.consumeTurn as typeof consumeTurn };
}

const admit = (ports: PublicTurnPorts, message: string, envelope = ADMISSION_DEFAULTS) =>
  admitPublicTurn({ sessionId: 'ses_1', publicEmbedId: EMBED, message }, envelope, ports);

describe('public turn admission', () => {
  it('admits an ordinary turn and spends one session slot', async () => {
    const { ports, consumeTurn } = harness();
    expect(await admit(ports, 'hello')).toEqual({ ok: true, turnCount: 1 });
    expect(consumeTurn).toHaveBeenCalledWith('ses_1', ADMISSION_DEFAULTS.turnsPerSession);
  });

  it('uses the sponsored default while keeping it as the customer-override ceiling', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports, consumeTurn } = harness({
      counters,
      embeds: embedsWith(embedRecord({ turnsPerDay: 9_000 })),
      resolveBudgetBounds: async () => ({
        defaults: { turnsPerSession: 40, turnsPerDay: 5_000, mintsPerDay: 1_000 },
        ceiling: { turnsPerDay: 5_000, mintsPerDay: 1_000 },
      }),
    });
    const spend = vi.spyOn(counters, 'consume');
    await admit(ports, 'hello');
    expect(consumeTurn).toHaveBeenCalledWith('ses_1', 40);
    expect(spend.mock.calls[0]?.[0]).toMatchObject({ limit: 5_000 });
  });

  it('refuses a message longer than the public bound', async () => {
    const { ports, consumeTurn } = harness();
    const result = await admit(ports, 'x'.repeat(ADMISSION_DEFAULTS.messageCharacters + 1));

    expect(result).toMatchObject({ ok: false, status: 400, code: 'message_too_long' });
    // The cheapest check runs first, so an oversized body never costs a turn.
    expect(consumeTurn).not.toHaveBeenCalled();
  });

  it('accepts a message exactly at the bound', async () => {
    const { ports } = harness();
    const result = await admit(ports, 'x'.repeat(ADMISSION_DEFAULTS.messageCharacters));
    expect(result).toMatchObject({ ok: true });
  });

  it('refuses once the session has spent its turns', async () => {
    const { ports } = harness({
      consumeTurn: vi.fn(async () => ({ allowed: false, turnCount: 20 })),
    });
    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      status: 429,
      code: 'session_turn_budget_exhausted',
    });
  });

  it('refuses once the surface has spent its day', async () => {
    const { ports } = harness();
    const envelope = clamp({ turnsPerDay: 2 });

    for (let turn = 0; turn < 2; turn += 1) {
      expect(await admit(ports, 'hello', envelope)).toMatchObject({ ok: true });
    }
    expect(await admit(ports, 'hello', envelope)).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_turn_budget_exhausted',
    });
  });

  /**
   * The kill switch, from the visitor's side. `budget set 0` has to stop conversations that are already
   * under way — a session that snapshotted its envelope at mint time would keep spending, which is
   * exactly the failure an operator reaches for the switch to stop.
   */
  it('stops an already-minted session when the daily budget is switched off', async () => {
    const { ports } = harness();
    expect(await admit(ports, 'hello', clamp({ turnsPerDay: 0 }))).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_turn_budget_exhausted',
    });
  });

  /**
   * Order matters and is part of the contract: a session with nothing left must not spend the customer's
   * daily budget on a turn that is about to be refused anyway.
   */
  it('does not spend surface budget on a session that has nothing left', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      consumeTurn: vi.fn(async () => ({ allowed: false, turnCount: 20 })),
    });

    await admit(ports, 'hello');

    expect(await counters.consume({ key: `turns:${EMBED}`, limit: 1 }, now)).toMatchObject({
      allowed: true,
    });
  });
});

describe('a surface’s own budget', () => {
  it('honours an operator’s lower turn cap over the deployment default', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({ counters, embeds: embedsWith(embedRecord({ turnsPerDay: 2 })) });

    expect((await admit(ports, 'one')).ok).toBe(true);
    expect((await admit(ports, 'two')).ok).toBe(true);
    // The default is 1,000; this surface was capped at 2, and the cap is what binds.
    expect(await admit(ports, 'three')).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_turn_budget_exhausted',
    });
  });

  /**
   * The kill switch, and the reason the envelope is read per turn rather than snapshotted at mint time:
   * an operator reaches for it precisely to stop conversations already under way.
   */
  it('stops a live conversation the moment the cap is set to zero', async () => {
    const { ports } = harness({ embeds: embedsWith(embedRecord({ turnsPerDay: 0 })) });

    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      code: 'daily_turn_budget_exhausted',
    });
  });

  it('cannot be raised above the structural maximum', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      embeds: embedsWith(embedRecord({ turnsPerDay: 999_999_999 })),
    });

    // An over-eager operator request degrades to the ceiling rather than becoming it: `clamp` is the
    // only way to build an envelope, so a number above ADMISSION_MAXIMUM is unrepresentable.
    const spend = vi.spyOn(counters, 'consume');
    await admit(ports, 'hello');
    expect(spend.mock.calls[0]?.[0].limit).toBe(ADMISSION_MAXIMUM.turnsPerDay);
  });

  /**
   * Revoking an embed used to stop new mints while leaving already-minted sessions talking. Reading the
   * record per turn — which the budget override needs anyway — closes that gap.
   */
  it('stops a session whose surface has been revoked', async () => {
    const { ports, consumeTurn } = harness({ embeds: embedsWith(undefined) });

    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      status: 403,
      code: 'embed_not_found',
    });
    expect(consumeTurn).not.toHaveBeenCalled();
  });
});

/**
 * The spend counter is the exact backstop behind the ladder's ceilings (ADR 0213 amendment §3). The
 * rung read that drives those ceilings is cached, so between refreshes it can say "plenty left" while
 * the day is in fact spent; this is the atomic statement that cannot.
 */
describe('platform spend admission', () => {
  const withSpend = (spend: { key: string; units: number; allowance: number } | undefined) => ({
    resolveBudgetBounds: async () => ({
      defaults: { turnsPerSession: 40, turnsPerDay: 5_000, mintsPerDay: 1_000 },
      ceiling: { turnsPerDay: 5_000, mintsPerDay: 1_000 },
      ...(spend ? { spend } : {}),
    }),
  });

  it('charges nothing and touches no key when the customer is paying', async () => {
    const counters = new InMemoryDailyCounterStore();
    const consume = vi.spyOn(counters, 'consume');
    const { ports } = harness({ counters, ...withSpend(undefined) });

    expect(await admit(ports, 'hello')).toMatchObject({ ok: true });
    expect(consume.mock.calls.map(([request]) => request.key)).toEqual([`turns:${EMBED}`]);
  });

  it('charges the turn its weighted cost against the tenant, not the surface', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      ...withSpend({ key: 'spend:acme/site/prod', units: 19, allowance: 100 }),
    });

    expect(await admit(ports, 'hello')).toMatchObject({ ok: true });
    expect(await counters.peek('spend:acme/site/prod', now)).toBe(19);
    // The surface's own day is charged one turn, whatever the platform paid for it.
    expect(await counters.peek(`turns:${EMBED}`, now)).toBe(1);
  });

  it('refuses with the code every shipped widget already treats as final', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      ...withSpend({ key: 'spend:acme/site/prod', units: 60, allowance: 100 }),
    });

    expect(await admit(ports, 'first')).toMatchObject({ ok: true });
    // A new refusal code would be unknown to every widget predating it, and therefore retryable —
    // they would hammer the endpoint this ceiling exists to protect.
    expect(await admit(ports, 'second')).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_turn_budget_exhausted',
    });
  });

  it('refuses with the surface own code once the platform allowance is spent', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      ...withSpend({ key: 'spend:acme/site/prod', units: 200, allowance: 100 }),
    });

    // Deliberately the surface's code, not a new one: every widget already shipped treats an
    // unknown code as retryable, so a new one would be retried against the ceiling it just met.
    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      code: 'daily_turn_budget_exhausted',
    });
  });

  it('lets an operator kill switch win over any platform allowance, and charges nothing', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      embeds: embedsWith(embedRecord({ turnsPerDay: 0 })),
      ...withSpend({ key: 'spend:acme/site/prod', units: 1, allowance: 1_000_000 }),
    });

    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      code: 'daily_turn_budget_exhausted',
    });
    // Every counter here is all-or-nothing and none of them refunds, so whichever runs first pays
    // for the turns the ones after it refuse. Spend runs last for that reason: a session reaching
    // its length limit is ordinary traffic many times a day, and the sponsor should not be billed
    // for the last turn of every conversation on the site.
    expect(await counters.peek('spend:acme/site/prod', now)).toBe(0);
  });

  it('charges no platform allowance for a turn the session refuses', async () => {
    const counters = new InMemoryDailyCounterStore();
    const { ports } = harness({
      counters,
      consumeTurn: async () => ({ allowed: false, turnCount: 40 }),
      ...withSpend({ key: 'spend:acme/site/prod', units: 1, allowance: 1_000_000 }),
    });

    expect(await admit(ports, 'hello')).toMatchObject({
      ok: false,
      code: 'session_turn_budget_exhausted',
    });
    expect(await counters.peek('spend:acme/site/prod', now)).toBe(0);
  });
});

/**
 * A browser agent calling governed tools through the WebMCP bridge (ADR 0220) spends no model turn, so
 * the turn budget does not bound it. These are the bounds that do.
 */
describe('bridge tool-call admission', () => {
  const bridgePorts = (overrides: Partial<BridgeToolCallPorts> = {}): BridgeToolCallPorts => ({
    counters: new InMemoryDailyCounterStore(),
    embeds: embedsWith(embedRecord()),
    now: () => now,
    ...overrides,
  });

  const admitBridge = (ports: BridgeToolCallPorts, envelope = ADMISSION_DEFAULTS) =>
    admitBridgeToolCall({ sessionId: 'ses_1', publicEmbedId: EMBED }, envelope, ports);

  it('admits a call within budget without spending a turn', async () => {
    const ports = bridgePorts();
    expect(await admitBridge(ports)).toEqual({ ok: true });
  });

  it('refuses once the session has spent its bridge allowance', async () => {
    const ports = bridgePorts();
    const envelope = clamp({ ...ADMISSION_DEFAULTS, bridgeToolCallsPerSession: 2 });

    expect(await admitBridge(ports, envelope)).toEqual({ ok: true });
    expect(await admitBridge(ports, envelope)).toEqual({ ok: true });
    expect(await admitBridge(ports, envelope)).toMatchObject({
      ok: false,
      status: 429,
      code: 'session_bridge_budget_exhausted',
    });
  });

  it('refuses once the surface has spent its day', async () => {
    const ports = bridgePorts();
    const envelope = clamp({ ...ADMISSION_DEFAULTS, bridgeToolCallsPerDay: 1 });

    expect(await admitBridge(ports, envelope)).toEqual({ ok: true });
    expect(await admitBridge(ports, envelope)).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_bridge_budget_exhausted',
    });
  });

  /**
   * The operator kill switch is one mechanism, not two: someone who sets `--turns-per-day 0` to stop a
   * surface means all of it, including tools a page agent can reach without ever running a turn.
   */
  it('stops when the operator has switched the surface off', async () => {
    const ports = bridgePorts();
    const envelope = clamp({ ...ADMISSION_DEFAULTS, turnsPerDay: 0 });

    expect(await admitBridge(ports, envelope)).toMatchObject({
      ok: false,
      status: 429,
      code: 'daily_bridge_budget_exhausted',
    });
  });

  it('stops a call on a surface that has been revoked', async () => {
    const ports = bridgePorts({ embeds: embedsWith(undefined) });

    expect(await admitBridge(ports)).toMatchObject({ ok: false, status: 403 });
  });

  it('fails closed when the counter store is unreachable', async () => {
    const counters = new InMemoryDailyCounterStore();
    vi.spyOn(counters, 'consume').mockRejectedValue(new Error('counter store unavailable'));

    expect(await admitBridge(bridgePorts({ counters }))).toMatchObject({
      ok: false,
      status: 503,
    });
  });
});

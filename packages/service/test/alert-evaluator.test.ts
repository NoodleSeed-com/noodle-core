import { randomUUID } from 'node:crypto';
import type { RequestEventInput, RequestOutcome } from '@noodle-borg/module';
import { createLogger } from '@noodle-borg/transport-http';
import { describe, expect, it, vi } from 'vitest';
import {
  AlertEvaluator,
  type AlertWebhookDelivery,
  type AlertWebhookPayload,
  type CreateAlertRuleInput,
  InMemoryAlertRuleStore,
  InMemoryRequestEventStore,
} from '../src/index.js';

/**
 * Evaluator unit tests (analytics alerting E2): edge-triggered firing (fire on the non-breaching →
 * breaching transition; re-fire while breaching only after the cooldown), per-metric observation
 * mapping over `aggregateRequestEvents`, window filtering, disabled-rule skipping, single-attempt
 * delivery without retry, per-rule fault isolation, throttled `maybeSweep`, and the invariant that
 * the webhook URL never reaches a log line.
 *
 * The in-memory request-event store stamps real wall-clock `createdAt`s, so the fake clock is
 * anchored at the real "now" and only ever advanced forward; window tests advance past the window
 * instead of back-dating events.
 */

const SECRET_URL = 'https://hooks.example.com/B00/secret-evaluator-token';

interface World {
  readonly rules: InMemoryAlertRuleStore;
  readonly events: InMemoryRequestEventStore;
  readonly evaluator: AlertEvaluator;
  readonly deliveries: { url: string; payload: AlertWebhookPayload }[];
  readonly logLines: string[];
  advance(ms: number): void;
  nowIso(): string;
  emit(outcome: RequestOutcome, extra?: Partial<RequestEventInput>): Promise<void>;
}

function makeWorld(
  options: {
    deliver?: (url: string, payload: AlertWebhookPayload) => Promise<AlertWebhookDelivery>;
    intervalMs?: number;
  } = {},
): World {
  const rules = new InMemoryAlertRuleStore();
  const events = new InMemoryRequestEventStore();
  const deliveries: { url: string; payload: AlertWebhookPayload }[] = [];
  const logLines: string[] = [];
  let nowMs = Date.now();
  const evaluator = new AlertEvaluator({
    alertRules: rules,
    requestEvents: events,
    clock: () => new Date(nowMs),
    logger: createLogger({ level: 'debug', sink: (line) => logLines.push(line) }),
    deliver: async (url, payload) => {
      deliveries.push({ url, payload });
      return options.deliver !== undefined
        ? options.deliver(url, payload)
        : { delivered: true, status: 200 };
    },
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
  });
  return {
    rules,
    events,
    evaluator,
    deliveries,
    logLines,
    advance: (ms) => {
      nowMs += ms;
    },
    nowIso: () => new Date(nowMs).toISOString(),
    emit: (outcome, extra = {}) =>
      events.emit({
        org: 'acme',
        app: 'support',
        env: 'prod',
        sessionSource: 'none',
        subjectKind: 'anonymous',
        kind: 'usage',
        durationMs: 50,
        requestId: randomUUID(),
        method: 'tools/call',
        toolName: 'search',
        outcome,
        ...extra,
      }),
  };
}

function rule(overrides: Partial<CreateAlertRuleInput> = {}): CreateAlertRuleInput {
  return {
    orgSlug: 'acme',
    appSlug: 'support',
    environment: 'prod',
    metric: 'error_share',
    threshold: 0.5,
    windowMinutes: 60,
    webhookUrl: SECRET_URL,
    ...overrides,
  };
}

describe('AlertEvaluator edge-triggering', () => {
  it('fires on the transition into breach and persists the firing state', async () => {
    const world = makeWorld();
    const created = await world.rules.createAlertRule(rule());
    await world.emit('ok');
    await world.emit('tool_error');

    const result = await world.evaluator.sweepNow();
    expect(result).toEqual({ evaluated: 1, fired: 1 });
    expect(world.deliveries).toHaveLength(1);
    const { payload } = world.deliveries[0] as { payload: AlertWebhookPayload };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.event).toBe('breach');
    expect(payload.org).toBe('acme');
    expect(payload.rule.id).toBe(created.id);
    expect(payload.rule.metric).toBe('error_share');
    expect(payload.observed).toBe(0.5);
    expect(payload.firedAt).toBe(world.nowIso());

    const after = await world.rules.getAlertRule(
      { org: 'acme', app: 'support', env: 'prod' },
      created.id,
    );
    expect(after).toMatchObject({
      breaching: true,
      lastObserved: 0.5,
      lastFiredAt: payload.firedAt,
    });
  });

  it('does not re-fire while breaching before the cooldown elapses', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ cooldownMinutes: 15 }));
    await world.emit('tool_error');
    await world.evaluator.sweepNow();
    world.advance(60_000); // 1 minute — still inside the cooldown
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
  });

  it('re-fires while still breaching once the cooldown has elapsed', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ cooldownMinutes: 15 }));
    await world.emit('tool_error');
    await world.evaluator.sweepNow();
    world.advance(16 * 60_000); // window is 60m: events remain in scope, cooldown elapsed
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(2);
    expect(world.deliveries[1]?.payload.event).toBe('breach');
  });

  it('resets on recovery and fires the next transition even inside the cooldown window', async () => {
    const world = makeWorld();
    const created = await world.rules.createAlertRule(rule({ cooldownMinutes: 60 }));
    await world.emit('ok');
    await world.emit('tool_error'); // share 0.5 >= 0.5
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);

    for (let i = 0; i < 6; i++) await world.emit('ok'); // share 1/8 — recovery
    world.advance(60_000);
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
    expect(
      await world.rules.getAlertRule({ org: 'acme', app: 'support', env: 'prod' }, created.id),
    ).toMatchObject({ breaching: false });

    for (let i = 0; i < 6; i++) await world.emit('tool_error'); // share 7/14 — breach again
    world.advance(60_000); // far inside the 60m cooldown — a NEW transition still fires
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(2);
  });

  it('never evaluates disabled rules', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ enabled: false, threshold: 0 }));
    await world.emit('tool_error');
    const result = await world.evaluator.sweepNow();
    expect(result).toEqual({ evaluated: 0, fired: 0 });
    expect(world.deliveries).toHaveLength(0);
  });
});

describe('AlertEvaluator metric mapping', () => {
  it('error_count counts tool and MCP errors in the window', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ metric: 'error_count', threshold: 2 }));
    await world.emit('tool_error');
    await world.emit('mcp_error');
    await world.emit('ok');
    await world.evaluator.sweepNow();
    expect(world.deliveries[0]?.payload.observed).toBe(2);
  });

  it('calls counts usage requests and excludes discovery traffic', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ metric: 'calls', threshold: 4 }));
    await world.emit('ok', { kind: 'usage', method: 'initialize', protocolEra: 'legacy' });
    for (let i = 0; i < 3; i++) await world.emit('ok');
    for (let i = 0; i < 2; i++) {
      await world.emit('ok', { kind: 'discovery', method: 'tools/list' });
    }
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(0); // 3 usage calls < 4 — discovery did not count

    await world.emit('ok');
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
    expect(world.deliveries[0]?.payload.observed).toBe(4);
  });

  it('p95_ms observes the p95 latency of usage calls', async () => {
    const world = makeWorld();
    await world.rules.createAlertRule(rule({ metric: 'p95_ms', threshold: 100 }));
    await world.emit('ok', { durationMs: 40 });
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(0);
    await world.emit('ok', { durationMs: 150 });
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
    expect(world.deliveries[0]?.payload.observed).toBe(150);
  });
});

describe('AlertEvaluator windows, faults, and throttling', () => {
  it('drops events outside the rule window and records the recovery', async () => {
    const world = makeWorld();
    const created = await world.rules.createAlertRule(
      rule({ metric: 'error_count', threshold: 1, windowMinutes: 5 }),
    );
    await world.emit('tool_error');
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);

    world.advance(10 * 60_000); // the only error is now outside the 5-minute window
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
    expect(
      await world.rules.getAlertRule({ org: 'acme', app: 'support', env: 'prod' }, created.id),
    ).toMatchObject({ breaching: false });
  });

  it('records the fire even when delivery fails — a single attempt, never a retry loop', async () => {
    const world = makeWorld({
      deliver: () => Promise.resolve({ delivered: false, reason: 'network_error' }),
    });
    await world.rules.createAlertRule(rule({ metric: 'error_count', threshold: 1 }));
    await world.emit('tool_error');
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
    world.advance(60_000); // still breaching, still inside cooldown — the failure is NOT retried
    await world.evaluator.sweepNow();
    expect(world.deliveries).toHaveLength(1);
  });

  it('a throwing delivery for one rule does not stop the others', async () => {
    const world = makeWorld({
      deliver: (url) =>
        url.includes('first')
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ delivered: true, status: 200 }),
    });
    await world.rules.createAlertRule(
      rule({ metric: 'error_count', threshold: 1, webhookUrl: 'https://hooks.example.com/first' }),
    );
    await world.rules.createAlertRule(
      rule({
        metric: 'error_count',
        threshold: 1,
        appSlug: 'support', // same tenant, second rule
        webhookUrl: 'https://hooks.example.com/second-secret',
      }),
    );
    await world.emit('tool_error');
    const result = await world.evaluator.sweepNow();
    expect(result.evaluated).toBe(2);
    expect(world.deliveries.some((d) => d.url.includes('second-secret'))).toBe(true);
  });

  it('maybeSweep throttles to the configured interval', async () => {
    const world = makeWorld({ intervalMs: 60_000 });
    const spy = vi.spyOn(world.rules, 'listEnabledAlertRules');
    world.evaluator.maybeSweep();
    world.evaluator.maybeSweep();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    world.advance(61_000);
    // The in-flight guard clears a microtask after the sweep resolves; poll like the real timer.
    await vi.waitFor(() => {
      world.evaluator.maybeSweep();
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  it('maybeSweep never overlaps a sweep that outlives the interval (no double-delivery race)', async () => {
    let release: (() => void) | undefined;
    const world = makeWorld({
      intervalMs: 60_000,
      deliver: () =>
        new Promise((resolve) => {
          release = () => resolve({ delivered: true, status: 200 });
        }),
    });
    const spy = vi.spyOn(world.rules, 'listEnabledAlertRules');
    await world.rules.createAlertRule(rule({ metric: 'error_count', threshold: 1 }));
    await world.emit('tool_error');

    world.evaluator.maybeSweep(); // starts a sweep that blocks inside delivery
    await vi.waitFor(() => expect(release).toBeDefined());
    world.advance(61_000); // interval elapsed, but the first sweep is still in flight
    world.evaluator.maybeSweep();
    expect(spy).toHaveBeenCalledTimes(1);

    release?.(); // finish the stuck delivery; the guard clears and the next tick sweeps again
    await vi.waitFor(() => expect(world.deliveries).toHaveLength(1));
    world.advance(61_000);
    await vi.waitFor(() => {
      world.evaluator.maybeSweep();
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  it('never writes the webhook URL into a log line', async () => {
    const world = makeWorld({
      deliver: () => Promise.resolve({ delivered: false, reason: 'network_error' }),
    });
    await world.rules.createAlertRule(rule({ metric: 'error_count', threshold: 1 }));
    await world.emit('tool_error');
    await world.evaluator.sweepNow();
    const logged = world.logLines.join('\n');
    expect(logged).toContain('alert.webhook.failed');
    expect(logged).not.toContain('secret-evaluator-token');
    expect(logged).not.toContain('hooks.example.com');
  });
});

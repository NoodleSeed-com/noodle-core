import type { RequestEventStore } from '@noodle-borg/module';
import { aggregateRequestEvents, type RequestMetrics } from '@noodle-borg/observability';
import { type Logger, noopLogger } from '@noodle-borg/transport-http';
import {
  type AlertWebhookDelivery,
  type AlertWebhookPayload,
  buildAlertWebhookPayload,
  deliverAlertWebhook,
} from './alert-webhook.js';
import type { AlertMetric, AlertRuleRecord, AlertRuleStore } from './store/alert-rules.js';

/**
 * Periodic alert-rule evaluator (E2, ADR 0130), modeled on `ArchiveSweeper`: a throttled
 * `maybeSweep()` (boot + a `serveService` interval timer) drives `sweepNow()`, which evaluates
 * every ENABLED rule against its own window of the tenant's request-event stream using the same
 * `aggregateRequestEvents` the metrics route serves — one aggregation, no duplicate math.
 *
 * EDGE-TRIGGERED: a rule fires on the non-breaching → breaching transition, and re-fires while
 * still breaching only after `cooldownMinutes` since the last fire. Delivery is a single attempt;
 * a failed delivery still stamps `lastFiredAt` so the sweep never becomes a retry loop (retries/
 * backoff are an explicit E3 deferral). Firing state persists so edge-triggering survives restarts.
 *
 * Logging is closed-vocabulary + rule id + HTTP status only — the webhook URL is sensitive and
 * never appears in any log line.
 *
 * Instance scope: the sweep is per-instance (in-flight-guarded and throttled locally). On a
 * multi-instance deployment two instances can each fire the same breach once before the shared
 * firing state persists — a duplicate notification, never lost/corrupted state. A cross-instance
 * atomic fire claim is an explicit E3 deferral (ADR 0130).
 */

export const ALERT_EVALUATION_INTERVAL_MS = 60_000;
/** Same bounded read as the metrics route (`METRICS_SCAN_LIMIT`). */
const EVAL_SCAN_LIMIT = 50_000;

/** The observed value a rule compares against its threshold, per metric. */
export function observedMetricValue(metric: AlertMetric, metrics: RequestMetrics): number {
  switch (metric) {
    case 'error_share':
      return metrics.errors.errorRate;
    case 'error_count':
      return metrics.errors.toolErrors + metrics.errors.mcpErrors;
    case 'calls':
      return metrics.totals.requests;
    case 'p95_ms':
      return metrics.latency.p95Ms;
  }
}

export interface AlertEvaluatorOptions {
  readonly alertRules: AlertRuleStore;
  readonly requestEvents: RequestEventStore;
  /** Dev/test-only loopback webhook carve-out, threaded to the delivery policy. Default false. */
  readonly allowLoopbackWebhooks?: boolean;
  /** Injectable delivery seam for tests. Default {@link deliverAlertWebhook}. */
  readonly deliver?: (
    url: string,
    payload: AlertWebhookPayload,
    options: { readonly allowLoopback: boolean },
  ) => Promise<AlertWebhookDelivery>;
  /** Injectable clock for deterministic edge-trigger/cooldown tests. Default `new Date()`. */
  readonly clock?: () => Date;
  readonly logger?: Logger;
  /** Throttle for {@link maybeSweep}. Default {@link ALERT_EVALUATION_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

export class AlertEvaluator {
  readonly #alertRules: AlertRuleStore;
  readonly #requestEvents: RequestEventStore;
  readonly #allowLoopback: boolean;
  readonly #deliver: NonNullable<AlertEvaluatorOptions['deliver']>;
  readonly #clock: () => Date;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #lastSweepStartedAt: number | undefined;
  #sweepInFlight = false;

  constructor(options: AlertEvaluatorOptions) {
    this.#alertRules = options.alertRules;
    this.#requestEvents = options.requestEvents;
    this.#allowLoopback = options.allowLoopbackWebhooks === true;
    this.#deliver =
      options.deliver ??
      ((url, payload, deliverOptions) => deliverAlertWebhook(url, payload, deliverOptions));
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    this.#intervalMs = options.intervalMs ?? ALERT_EVALUATION_INTERVAL_MS;
  }

  /**
   * Throttled, fire-and-forget sweep (the serve-time interval calls this): never throws, and
   * never overlaps — a sweep that outlives the interval (slow store/webhook timeouts) must not
   * race a second sweep into double-delivering the same breach before state persists.
   */
  maybeSweep(): void {
    if (this.#sweepInFlight) return;
    const now = this.#clock().getTime();
    if (
      this.#lastSweepStartedAt !== undefined &&
      now - this.#lastSweepStartedAt < this.#intervalMs
    ) {
      return;
    }
    this.#lastSweepStartedAt = now;
    this.#sweepInFlight = true;
    void this.sweepNow()
      .catch((error: unknown) => {
        this.#logger.warn('alert.sweep.failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.#sweepInFlight = false;
      });
  }

  async sweepNow(): Promise<{ readonly evaluated: number; readonly fired: number }> {
    const rules = await this.#alertRules.listEnabledAlertRules();
    let fired = 0;
    for (const rule of rules) {
      try {
        if (await this.#evaluateRule(rule)) fired += 1;
      } catch (error) {
        // One bad rule (store fault, throwing delivery seam) must not starve the others. Store
        // errors never carry the webhook URL; delivery outcomes are closed codes by construction.
        this.#logger.warn('alert.evaluate.failed', {
          ruleId: rule.id,
          message: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return { evaluated: rules.length, fired };
  }

  async #evaluateRule(rule: AlertRuleRecord): Promise<boolean> {
    const now = this.#clock();
    const since = new Date(now.getTime() - rule.windowMinutes * 60_000).toISOString();
    const events = await this.#requestEvents.list({
      org: rule.orgSlug,
      app: rule.appSlug,
      env: rule.environment,
      since,
      limit: EVAL_SCAN_LIMIT,
    });
    const observed = observedMetricValue(rule.metric, aggregateRequestEvents(events));
    const breaching = observed >= rule.threshold;

    const transition = breaching && !rule.breaching;
    const cooldownElapsed =
      rule.lastFiredAt === undefined ||
      now.getTime() - Date.parse(rule.lastFiredAt) >= rule.cooldownMinutes * 60_000;
    const shouldFire = transition || (breaching && rule.breaching && cooldownElapsed);

    if (shouldFire) {
      const firedAt = now.toISOString();
      const payload = buildAlertWebhookPayload(rule, 'breach', observed, firedAt);
      const outcome = await this.#deliver(rule.webhookUrl, payload, {
        allowLoopback: this.#allowLoopback,
      });
      if (outcome.delivered) {
        this.#logger.info('alert.webhook.delivered', {
          ruleId: rule.id,
          status: outcome.status ?? 0,
        });
      } else {
        this.#logger.warn('alert.webhook.failed', {
          ruleId: rule.id,
          reason: outcome.reason ?? 'unknown',
          ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        });
      }
      // Stamp the fire regardless of delivery outcome: a single attempt, never a retry loop (E3).
      await this.#alertRules.updateAlertFiringState(rule.id, {
        breaching: true,
        lastObserved: observed,
        lastFiredAt: firedAt,
      });
      return true;
    }
    if (breaching !== rule.breaching) {
      // Recovery (or a breach the fire path above already covers): persist the edge so the next
      // crossing is a fresh transition. `lastFiredAt` is preserved by omission.
      await this.#alertRules.updateAlertFiringState(rule.id, {
        breaching,
        lastObserved: observed,
      });
    }
    return false;
  }
}

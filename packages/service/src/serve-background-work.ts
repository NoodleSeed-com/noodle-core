import type { IntentEventStore, RequestEventStore } from '@noodle-borg/module';
import {
  createTelemetryRuntime,
  InMemoryIntentEventStore,
  InMemoryRequestEventStore,
  type TelemetryRuntime,
} from '@noodle-borg/observability';
import { type Logger, noopLogger } from '@noodle-borg/transport-http';
import { ALERT_EVALUATION_INTERVAL_MS, AlertEvaluator } from './alert-evaluator.js';
import type { SourceIngestionCoordinator } from './business-information/portable.js';
import { retentionSweepTrigger } from './business-information/retention-sweeper.js';
import { drainSourceIngestion } from './business-information/source-ingestion-coordinator.js';
import type { ServeServiceOptions } from './serve-options.js';
import type { AlertRuleStore } from './store/alert-rules.js';

/** The analytics write-behind runtime and the alert evaluator, both started at boot. */
export function startAnalyticsAndAlerts(input: {
  readonly options: ServeServiceOptions;
  readonly requestEventStore: RequestEventStore;
  readonly intentEventStore: IntentEventStore;
  readonly alertRuleStore: AlertRuleStore;
}): { readonly telemetry: TelemetryRuntime; readonly alertTimer?: NodeJS.Timeout } {
  const { options, requestEventStore, intentEventStore, alertRuleStore } = input;
  // Analytics write-behind buffer + Stage-A default retention (ADR 0121): capture is enqueue-only on the
  // request path; the durable stream is pruned on boot and periodically to the retention window.
  // The retention override fails closed at boot (mirroring resolveArchiveRetentionDays): a negative or
  // fractional value would flip the prune cutoff into the future and delete the entire stream.
  const retentionDays = options.requestEventRetentionDays ?? 30;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error('requestEventRetentionDays must be a positive integer number of days');
  }
  // serve-only: probes capture nothing, and nothing captured may reach production analytics, so the
  // buffers drain into memory; no pruner, heartbeat or alert sweep (which delivers webhooks) starts.
  if (options.runMode === 'serve-only')
    return {
      telemetry: createTelemetryRuntime(
        new InMemoryRequestEventStore(),
        new InMemoryIntentEventStore(),
        retentionDays,
      ),
    };
  // The runtime owns its buffers/timers lifecycle and, when a logger is present, the periodic
  // `telemetry.health` pipeline-health heartbeat (#1309).
  const telemetry = createTelemetryRuntime(requestEventStore, intentEventStore, retentionDays, {
    ...(options.logger === undefined ? {} : { heartbeatLogger: options.logger }),
  });

  // Analytics alerting evaluator (E2, ADR 0130): a periodic edge-triggered sweep over enabled
  // alert rules with single-attempt SSRF-guarded webhook delivery. The interval timer mirrors the
  // retention prune above; `maybeSweep` throttles internally, so a boot sweep is safe here too.
  const alertEvaluator = new AlertEvaluator({
    alertRules: alertRuleStore,
    requestEvents: requestEventStore,
    allowLoopbackWebhooks: options.alertWebhookAllowLoopback === true,
    logger: options.logger ?? noopLogger,
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
  });
  alertEvaluator.maybeSweep();
  const alertTimer = setInterval(() => alertEvaluator.maybeSweep(), ALERT_EVALUATION_INTERVAL_MS);
  alertTimer.unref?.();
  return { telemetry, alertTimer };
}

/** The 15-minute retention sweep over business information, sources, history and operation evidence. */
export function startRetentionSweep(
  targets: Parameters<typeof retentionSweepTrigger>[0],
  logger: Logger,
): { readonly timer: NodeJS.Timeout; readonly stop: () => void } {
  const sweep = retentionSweepTrigger(targets, logger);
  sweep();
  const timer = setInterval(sweep, 15 * 60 * 1000);
  timer.unref?.();
  return { timer, stop: sweep.close };
}

/** The 30-second business-information source ingestion drain. */
export function startSourceIngestion(
  sourceCoordinator: SourceIngestionCoordinator,
  logger: Logger,
): NodeJS.Timeout {
  const sweepSources = (): void => {
    void drainSourceIngestion(sourceCoordinator).catch((error: unknown) => {
      logger.error('business_information.source.failed', {
        name: error instanceof Error ? error.name : 'unknown',
        code:
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string'
            ? error.code
            : 'source_scan_failed',
      });
    });
  };
  sweepSources();
  const timer = setInterval(sweepSources, 30_000);
  timer.unref?.();
  return timer;
}

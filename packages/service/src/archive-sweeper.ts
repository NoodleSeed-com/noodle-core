/**
 * Opportunistic retention sweeper for archived apps (ADR 0117 §3). No scheduler: the service
 * handler fires one sweep at construction (boot) and piggybacks a throttled, fire-and-forget
 * `maybeSweep()` on the deploy and deployments-list control-plane paths. A sweep hard-deletes
 * every deployment record archived before the retention cutoff, reclaims the purged app's managed
 * config (app scope + the swept environments' env scopes — org scope is shared and untouched),
 * and emits one `app.purged` audit event per org/app.
 */
import { type Logger, noopLogger } from '@noodle-borg/transport-http';
import type { ServerRegistry } from './registry.js';
import type { AuditSink } from './store/audit.js';
import {
  type ConfigStore,
  type DeployRecord,
  type ManagedConfigKind,
  resolveConfigScope,
} from './store.js';

/** Platform default retention: archived apps are hard-deleted after this many days. */
export const DEFAULT_ARCHIVE_RETENTION_DAYS = 30;
/** Piggybacked sweeps run at most this often per instance; boot always sweeps once. */
export const ARCHIVE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const CONFIG_KINDS: readonly ManagedConfigKind[] = ['secret', 'variable'];

/** Resolve the retention override from env. Fails closed on a malformed value (boot-time error). */
export function resolveArchiveRetentionDays(env: NodeJS.ProcessEnv): number {
  const raw = env.NOODLE_ARCHIVE_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_ARCHIVE_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('NOODLE_ARCHIVE_RETENTION_DAYS must be a positive integer number of days');
  }
  return parsed;
}

export interface ArchiveSweeperOptions {
  readonly registry: ServerRegistry;
  readonly configStore: ConfigStore;
  readonly audit: AuditSink;
  readonly retentionDays: number;
  /** Injectable clock for deterministic retention tests. Default: `new Date()`. */
  readonly clock?: () => Date;
  readonly logger?: Logger;
  /** Throttle for {@link maybeSweep}. Default {@link ARCHIVE_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number;
}

interface PurgedApp {
  readonly org: string;
  readonly app: string;
  readonly envs: Set<string>;
  count: number;
}

export class ArchiveSweeper {
  readonly #registry: ServerRegistry;
  readonly #configStore: ConfigStore;
  readonly #audit: AuditSink;
  readonly #retentionDays: number;
  readonly #clock: () => Date;
  readonly #logger: Logger;
  readonly #intervalMs: number;
  #lastSweepStartedAt: number | undefined;

  constructor(options: ArchiveSweeperOptions) {
    this.#registry = options.registry;
    this.#configStore = options.configStore;
    this.#audit = options.audit;
    this.#retentionDays = options.retentionDays;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger ?? noopLogger;
    this.#intervalMs = options.intervalMs ?? ARCHIVE_SWEEP_INTERVAL_MS;
  }

  /**
   * Throttled, fire-and-forget sweep for request-path piggybacking: never blocks or fails the
   * carrying request. The first call (boot) always sweeps.
   */
  maybeSweep(): void {
    const now = this.#clock().getTime();
    if (
      this.#lastSweepStartedAt !== undefined &&
      now - this.#lastSweepStartedAt < this.#intervalMs
    ) {
      return;
    }
    this.#lastSweepStartedAt = now;
    void this.sweepNow().catch((error: unknown) => {
      this.#logger.warn('archive.sweep.failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async sweepNow(): Promise<{ readonly deletedDeployments: number; readonly purgedApps: number }> {
    const cutoff = new Date(this.#clock().getTime() - this.#retentionDays * DAY_MS).toISOString();
    const deleted = await this.#registry.sweepArchived(cutoff);
    if (deleted.length === 0) return { deletedDeployments: 0, purgedApps: 0 };
    const apps = groupByApp(deleted);
    for (const entry of apps.values()) {
      await this.#deleteAppConfig(entry);
      await this.#audit.emit({
        eventType: 'app.purged',
        org: entry.org,
        app: entry.app,
        decision: 'allow',
        reasonCode: 'retention_elapsed',
        details: {
          deletedDeployments: entry.count,
          retentionDays: this.#retentionDays,
          archivedBefore: cutoff,
        },
      });
    }
    this.#logger.info('archive.sweep.completed', {
      deletedDeployments: deleted.length,
      purgedApps: apps.size,
    });
    return { deletedDeployments: deleted.length, purgedApps: apps.size };
  }

  /** Reclaim the purged app's managed config: app scope + each swept environment's env scope. */
  async #deleteAppConfig(entry: PurgedApp): Promise<void> {
    const scopes = [
      resolveConfigScope({ org: entry.org, app: entry.app }),
      ...[...entry.envs].map((env) => resolveConfigScope({ org: entry.org, app: entry.app, env })),
    ];
    for (const scope of scopes) {
      for (const kind of CONFIG_KINDS) {
        const values = await this.#configStore.listConfigValues(kind, scope);
        for (const value of values) {
          await this.#configStore.deleteConfigValue(kind, scope, value.name);
        }
      }
    }
  }
}

function groupByApp(deleted: readonly DeployRecord[]): Map<string, PurgedApp> {
  const apps = new Map<string, PurgedApp>();
  for (const record of deleted) {
    const key = `${record.orgSlug}/${record.appSlug}`;
    const entry = apps.get(key) ?? {
      org: record.orgSlug,
      app: record.appSlug,
      envs: new Set<string>(),
      count: 0,
    };
    entry.envs.add(record.environment);
    entry.count += 1;
    apps.set(key, entry);
  }
  return apps;
}

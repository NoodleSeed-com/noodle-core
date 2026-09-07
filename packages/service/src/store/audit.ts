import { randomUUID } from 'node:crypto';
import type {
  AuditEvent,
  AuditEventInput,
  AuditFilter,
  AuditSink,
  AuditStore,
} from '@noodle-borg/module';
import { AUDIT_SCHEMA_VERSION, redactDetails } from '@noodle-borg/module';
import type { Logger } from '@noodle-borg/transport-http';
import { validateSlug } from '../store.js';

export type {
  AuditDecision,
  AuditDetails,
  AuditEvent,
  AuditEventInput,
  AuditFilter,
  AuditSink,
  AuditStore,
} from '@noodle-borg/module';
export { AUDIT_SCHEMA_VERSION, redactDetails } from '@noodle-borg/module';

/**
 * Durable audit/event records (Phase 0 governance spine). The canonical event is a **tenant-scoped, flat,
 * scalar-only** record so the same shape can be written to the first-party system of record, mirrored to
 * stdout, and (later) exported to an OTel Collector / object store / webhook — without any emission site
 * knowing the backend. Redaction is structural: {@link redactDetails} drops any non-scalar `details` value
 * to a marker, so a stray token-bearing object can never reach a stored row or a log line.
 */

/** Build the canonical stored event from an input, stamping id, schema version, and timestamp. */
function toAuditEvent(input: AuditEventInput, id: string, createdAt: Date): AuditEvent {
  const details = redactDetails(input.details);
  return {
    id,
    schemaVersion: AUDIT_SCHEMA_VERSION,
    eventType: input.eventType,
    org: input.org,
    createdAt: createdAt.toISOString(),
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
    ...(input.actorSubject !== undefined ? { actorSubject: input.actorSubject } : {}),
    ...(input.actorEmail !== undefined ? { actorEmail: input.actorEmail } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.status !== undefined ? { status: String(input.status) } : {}),
    ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

export interface InMemoryAuditStoreOptions {
  readonly now?: () => Date;
  readonly id?: () => string;
}

/** In-memory system of record: an append-only list. Used by tests and the non-persistent dev default. */
export class InMemoryAuditStore implements AuditStore {
  readonly #events: AuditEvent[] = [];
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: InMemoryAuditStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => randomUUID());
  }

  emit(input: AuditEventInput): Promise<void> {
    this.#events.push(toAuditEvent(input, this.#id(), this.#now()));
    return Promise.resolve();
  }

  list(filter: AuditFilter): Promise<readonly AuditEvent[]> {
    const org = validateSlug('org', filter.org);
    const matched = this.#events.filter(
      (event) =>
        event.org === org &&
        (filter.app === undefined || event.app === filter.app) &&
        (filter.env === undefined || event.env === filter.env) &&
        (filter.eventType === undefined || event.eventType === filter.eventType),
    );
    // Pushed in chronological order, so reverse yields newest-first with a stable tiebreak on insertion.
    matched.reverse();
    return Promise.resolve(filter.limit !== undefined ? matched.slice(0, filter.limit) : matched);
  }
}

/**
 * Write-only mirror that emits one redacted `audit.<eventType>` line through the structured {@link Logger}.
 * On Cloud Run this stdout line is picked up by Cloud Logging's Log Router (→ BigQuery/GCS/Pub/Sub) at zero
 * extra cost. It is a best-effort mirror, never the system of record.
 */
export class StdoutAuditSink implements AuditSink {
  readonly #logger: Logger;

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  emit(input: AuditEventInput): Promise<void> {
    this.#logger.info(`audit.${input.eventType}`, {
      org: input.org,
      ...(input.app !== undefined ? { app: input.app } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
      ...(input.actorSubject !== undefined ? { actorSubject: input.actorSubject } : {}),
      ...(input.actorEmail !== undefined ? { actorEmail: input.actorEmail } : {}),
      ...(input.decision !== undefined ? { decision: input.decision } : {}),
      ...(input.status !== undefined ? { status: String(input.status) } : {}),
      ...(input.reasonCode !== undefined ? { reasonCode: input.reasonCode } : {}),
      ...redactDetails(input.details),
    });
    return Promise.resolve();
  }
}

/**
 * Fan-out sink: the **primary** is the system of record (its failure surfaces — the durability guarantee),
 * and each **mirror** is best-effort (a failing mirror is swallowed so a slow/broken downstream never blocks
 * the audited action). Async buffering/retry/dead-letter for mirrors lands with the export-adapter slice.
 */
export class MultiSink implements AuditStore {
  readonly #primary: AuditSink;
  readonly #mirrors: readonly AuditSink[];

  constructor(primary: AuditSink, mirrors: readonly AuditSink[] = []) {
    this.#primary = primary;
    this.#mirrors = mirrors;
  }

  async emit(input: AuditEventInput): Promise<void> {
    await this.#primary.emit(input);
    await this.emitMirrors(input);
  }

  /**
   * Deliver an event whose canonical row already committed with its state change. This deliberately skips
   * the primary system of record so transaction-owning callers can still reach every configured export
   * mirror without inserting a duplicate durable row.
   */
  async emitMirrors(input: AuditEventInput): Promise<void> {
    for (const mirror of this.#mirrors) {
      try {
        await mirror.emit(input);
      } catch {
        // Mirrors are best-effort; a failing export must not fail the audited action.
      }
    }
  }

  list(filter: AuditFilter): Promise<readonly AuditEvent[]> {
    if (!isAuditStore(this.#primary)) {
      throw new Error('primary audit sink does not support event queries');
    }
    return this.#primary.list(filter);
  }
}

/** Best-effort mirror delivery for a canonical event already persisted by the owning transaction. */
export function emitAuditMirrors(sink: AuditSink, input: AuditEventInput): Promise<void> {
  return isAuditMirrorFanout(sink) ? sink.emitMirrors(input) : Promise.resolve();
}

function isAuditMirrorFanout(
  sink: AuditSink,
): sink is AuditSink & { emitMirrors(input: AuditEventInput): Promise<void> } {
  return 'emitMirrors' in sink && typeof sink.emitMirrors === 'function';
}

function isAuditStore(sink: AuditSink): sink is AuditStore {
  return 'list' in sink && typeof sink.list === 'function';
}

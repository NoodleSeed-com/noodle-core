import { randomUUID } from 'node:crypto';
import {
  REQUEST_EVENT_SCHEMA_VERSION,
  type RequestEvent,
  type RequestEventFilter,
  type RequestEventInput,
  type RequestEventStore,
  redactDetails,
} from '@noodle-borg/module';

const DEFAULT_CAP = 10_000;

function toRequestEvent(input: RequestEventInput): RequestEvent {
  const details = redactDetails(input.details);
  return {
    id: randomUUID(),
    schemaVersion: REQUEST_EVENT_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    org: input.org,
    requestId: input.requestId,
    sessionSource: input.sessionSource,
    subjectKind: input.subjectKind,
    method: input.method,
    kind: input.kind,
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.app !== undefined ? { app: input.app } : {}),
    ...(input.env !== undefined ? { env: input.env } : {}),
    ...(input.deploymentId !== undefined ? { deploymentId: input.deploymentId } : {}),
    ...(input.serverVersion !== undefined ? { serverVersion: input.serverVersion } : {}),
    ...(input.sdkProtocolVersion !== undefined
      ? { sdkProtocolVersion: input.sdkProtocolVersion }
      : {}),
    ...(input.protocolEra !== undefined ? { protocolEra: input.protocolEra } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.clientName !== undefined ? { clientName: input.clientName } : {}),
    ...(input.clientVersion !== undefined ? { clientVersion: input.clientVersion } : {}),
    ...(input.clientFamily !== undefined ? { clientFamily: input.clientFamily } : {}),
    ...(input.accessMode !== undefined ? { accessMode: input.accessMode } : {}),
    ...(input.surface !== undefined ? { surface: input.surface } : {}),
    ...(input.toolName !== undefined ? { toolName: input.toolName } : {}),
    ...(input.resourceName !== undefined ? { resourceName: input.resourceName } : {}),
    ...(input.promptName !== undefined ? { promptName: input.promptName } : {}),
    ...(input.errorKind !== undefined ? { errorKind: input.errorKind } : {}),
    ...(input.queueMs !== undefined ? { queueMs: input.queueMs } : {}),
    ...(input.execMs !== undefined ? { execMs: input.execMs } : {}),
    ...(input.outputTokensEst !== undefined ? { outputTokensEst: input.outputTokensEst } : {}),
    ...(input.country !== undefined ? { country: input.country } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function matches(event: RequestEvent, filter: RequestEventFilter): boolean {
  if (filter.app !== undefined && event.app !== filter.app) return false;
  if (filter.env !== undefined && event.env !== filter.env) return false;
  if (filter.method !== undefined && event.method !== filter.method) return false;
  if (filter.outcome !== undefined && event.outcome !== filter.outcome) return false;
  if (filter.toolName !== undefined && event.toolName !== filter.toolName) return false;
  if (filter.clientName !== undefined && event.clientName !== filter.clientName) return false;
  if (filter.surface !== undefined && event.surface !== filter.surface) return false;
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
  if (filter.since !== undefined && event.createdAt < filter.since) return false;
  if (filter.until !== undefined && event.createdAt > filter.until) return false;
  return true;
}

/**
 * In-memory {@link RequestEventStore} for local dev and tests: one **global** bounded drop-oldest
 * ring (a busy tenant can evict another's events — acceptable for a dev/test-only store; the durable
 * Postgres store is the real system of record with per-window retention). Mirrors the audit store's
 * redaction discipline (scalar-only `details`).
 */
export class InMemoryRequestEventStore implements RequestEventStore {
  readonly #events: RequestEvent[] = [];
  readonly #cap: number;

  constructor(cap: number = DEFAULT_CAP) {
    this.#cap = cap;
  }

  emit(input: RequestEventInput): Promise<void> {
    this.#events.push(toRequestEvent(input));
    if (this.#events.length > this.#cap) {
      this.#events.splice(0, this.#events.length - this.#cap);
    }
    return Promise.resolve();
  }

  list(filter: RequestEventFilter): Promise<readonly RequestEvent[]> {
    const matched = this.#events.filter((e) => e.org === filter.org && matches(e, filter));
    matched.reverse(); // newest-first
    // Guard malformed limits (NaN would make slice() silently return []).
    const raw = filter.limit !== undefined ? Math.floor(filter.limit) : undefined;
    const limit = raw !== undefined && Number.isFinite(raw) ? Math.max(0, raw) : undefined;
    return Promise.resolve(limit !== undefined ? matched.slice(0, limit) : matched);
  }
}

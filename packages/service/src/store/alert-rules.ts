import { randomUUID } from 'node:crypto';
import type { TenantRef } from '../store.js';
import { validateSlug } from './validate.js';

/**
 * Analytics alert rules (E2, [ADR 0130](../../../../docs/decisions/0130-analytics-alerting-rules-and-webhook-channel.md)):
 * a rule is data scoped to org/app/env, evaluated periodically against the tenant's request-event
 * aggregations, edge-triggered (fire on the non-breaching → breaching transition; re-fire while
 * breaching only after the cooldown). The MVP channel is a webhook URL.
 *
 * `webhookUrl` is SENSITIVE — hosted webhook endpoints routinely embed capability tokens in the
 * path/query. It exists only inside the store and the delivery path; routes serialize rules through
 * a redacting view and no log line, error message, or audit detail may ever carry it.
 */

export const ALERT_METRICS = ['error_share', 'error_count', 'calls', 'p95_ms'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export const ALERT_WINDOWS_MINUTES = [5, 15, 60] as const;
export type AlertWindowMinutes = (typeof ALERT_WINDOWS_MINUTES)[number];

export const DEFAULT_ALERT_COOLDOWN_MINUTES = 15;
/** Cheap abuse bound: an env's owner cannot turn the evaluator into a webhook flood. */
export const MAX_ALERT_RULES_PER_ENV = 20;
const MAX_ALERT_NAME_LENGTH = 100;
const MAX_WEBHOOK_URL_LENGTH = 2048;
const MAX_COOLDOWN_MINUTES = 24 * 60;

/** Rule ids are always service-minted UUIDs; enforcing the shape everywhere also makes ids safe filename components. */
const ALERT_RULE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface AlertRuleRecord {
  readonly id: string;
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly name?: string;
  readonly metric: AlertMetric;
  readonly threshold: number;
  readonly windowMinutes: AlertWindowMinutes;
  /** MVP supports only `>=`; persisted so a later slice can widen without a data migration. */
  readonly comparison: '>=';
  /** SENSITIVE (may embed tokens): never logged, never serialized into responses. */
  readonly webhookUrl: string;
  readonly enabled: boolean;
  readonly cooldownMinutes: number;
  readonly createdBySubject?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Edge-trigger state: whether the last evaluation observed a breach. */
  readonly breaching: boolean;
  /** Observed metric value at the last state change or fire. */
  readonly lastObserved?: number;
  readonly lastFiredAt?: string;
}

export interface CreateAlertRuleInput {
  readonly orgSlug: string;
  readonly appSlug: string;
  readonly environment: string;
  readonly name?: string;
  readonly metric: AlertMetric;
  readonly threshold: number;
  readonly windowMinutes: AlertWindowMinutes;
  readonly webhookUrl: string;
  /** Default `true`. */
  readonly enabled?: boolean;
  /** Default {@link DEFAULT_ALERT_COOLDOWN_MINUTES}. */
  readonly cooldownMinutes?: number;
  readonly createdBySubject?: string;
}

export interface AlertFiringState {
  readonly breaching: boolean;
  readonly lastObserved: number;
  /** When present, records a fire; when absent the existing `lastFiredAt` is preserved. */
  readonly lastFiredAt?: string;
}

/**
 * Store surface for analytics alert rules. Backends: in-memory (tests/dev default), JSON-file
 * (`dataDir` local persistence), and Postgres (hosted) — selected in `serveService` the same way
 * as the request-event store.
 */
export interface AlertRuleStore {
  createAlertRule(input: CreateAlertRuleInput): Promise<AlertRuleRecord>;
  listAlertRules(ref: TenantRef): Promise<readonly AlertRuleRecord[]>;
  getAlertRule(ref: TenantRef, id: string): Promise<AlertRuleRecord | undefined>;
  /** `true` iff the rule existed in this tenant scope and was deleted. */
  deleteAlertRule(ref: TenantRef, id: string): Promise<boolean>;
  /** Every enabled rule across all tenants — the evaluator sweep input. */
  listEnabledAlertRules(): Promise<readonly AlertRuleRecord[]>;
  /** Persist edge-trigger state; `undefined` when the rule no longer exists. */
  updateAlertFiringState(id: string, state: AlertFiringState): Promise<AlertRuleRecord | undefined>;
}

export function validateAlertRuleId(id: string): string {
  if (!ALERT_RULE_ID_PATTERN.test(id)) throw new Error('invalid alert rule id');
  return id;
}

/** True when the segment is shaped like a service-minted rule id (path parsing, non-throwing). */
export function isAlertRuleId(id: string): boolean {
  return ALERT_RULE_ID_PATTERN.test(id);
}

/**
 * Shared shape validation for rule creation, used by every backend. Applies defaults. Policy
 * validation of the webhook URL (https-only, loopback carve-out, private-IP rejection) is the
 * route's job (`validateAlertWebhookUrl`); the store only rejects structurally broken values.
 */
function validateCreateAlertRuleInput(
  input: CreateAlertRuleInput,
): Required<Pick<CreateAlertRuleInput, 'enabled' | 'cooldownMinutes'>> & CreateAlertRuleInput {
  const orgSlug = validateSlug('org', input.orgSlug);
  const appSlug = validateSlug('app', input.appSlug);
  const environment = validateSlug('env', input.environment);
  if (!ALERT_METRICS.includes(input.metric)) {
    throw new Error(`invalid alert metric; expected one of ${ALERT_METRICS.join(', ')}`);
  }
  if (
    typeof input.threshold !== 'number' ||
    !Number.isFinite(input.threshold) ||
    input.threshold < 0
  ) {
    throw new Error('invalid alert threshold; expected a finite number >= 0');
  }
  if (!ALERT_WINDOWS_MINUTES.includes(input.windowMinutes)) {
    throw new Error(
      `invalid alert window; expected one of ${ALERT_WINDOWS_MINUTES.join(', ')} minutes`,
    );
  }
  const cooldownMinutes = input.cooldownMinutes ?? DEFAULT_ALERT_COOLDOWN_MINUTES;
  if (
    !Number.isInteger(cooldownMinutes) ||
    cooldownMinutes < 1 ||
    cooldownMinutes > MAX_COOLDOWN_MINUTES
  ) {
    throw new Error(
      `invalid alert cooldown; expected an integer from 1 to ${MAX_COOLDOWN_MINUTES} minutes`,
    );
  }
  if (input.name !== undefined) {
    if (
      typeof input.name !== 'string' ||
      input.name.length === 0 ||
      input.name.length > MAX_ALERT_NAME_LENGTH
    ) {
      throw new Error(`invalid alert name; expected 1-${MAX_ALERT_NAME_LENGTH} characters`);
    }
  }
  if (
    typeof input.webhookUrl !== 'string' ||
    input.webhookUrl.length === 0 ||
    input.webhookUrl.length > MAX_WEBHOOK_URL_LENGTH ||
    !isHttpUrl(input.webhookUrl)
  ) {
    throw new Error('invalid webhookUrl; expected an http(s) URL');
  }
  return {
    ...input,
    orgSlug,
    appSlug,
    environment,
    enabled: input.enabled ?? true,
    cooldownMinutes,
  };
}

function isHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Build the durable record from a validated input (shared by the in-memory and JSON-file backends). */
export function newAlertRuleRecord(input: CreateAlertRuleInput, now: () => Date): AlertRuleRecord {
  const safe = validateCreateAlertRuleInput(input);
  const nowIso = now().toISOString();
  return {
    id: randomUUID(),
    orgSlug: safe.orgSlug,
    appSlug: safe.appSlug,
    environment: safe.environment,
    ...(safe.name !== undefined ? { name: safe.name } : {}),
    metric: safe.metric,
    threshold: safe.threshold,
    windowMinutes: safe.windowMinutes,
    comparison: '>=',
    webhookUrl: safe.webhookUrl,
    enabled: safe.enabled,
    cooldownMinutes: safe.cooldownMinutes,
    ...(safe.createdBySubject !== undefined ? { createdBySubject: safe.createdBySubject } : {}),
    createdAt: nowIso,
    updatedAt: nowIso,
    breaching: false,
  };
}

/** Apply a firing-state update, preserving `lastFiredAt` when the update does not carry one. */
export function withFiringState(record: AlertRuleRecord, state: AlertFiringState): AlertRuleRecord {
  const lastFiredAt = state.lastFiredAt ?? record.lastFiredAt;
  return {
    ...record,
    breaching: state.breaching,
    lastObserved: state.lastObserved,
    ...(lastFiredAt !== undefined ? { lastFiredAt } : {}),
  };
}

/** Stable list order across backends: `createdAt`, then `id` (matches the Postgres `ORDER BY`). */
export function compareAlertRules(a: AlertRuleRecord, b: AlertRuleRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function matchesTenant(record: AlertRuleRecord, ref: TenantRef): boolean {
  return record.orgSlug === ref.org && record.appSlug === ref.app && record.environment === ref.env;
}

function validateTenantRefSlugs(ref: TenantRef): TenantRef {
  return {
    org: validateSlug('org', ref.org),
    app: validateSlug('app', ref.app),
    env: validateSlug('env', ref.env),
  };
}

/** In-memory {@link AlertRuleStore}: the tests/dev default; mirrors `InMemoryGithubConnectionStore`. */
export class InMemoryAlertRuleStore implements AlertRuleStore {
  readonly #records = new Map<string, AlertRuleRecord>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  // Methods are async so validation failures surface as rejections (matching the file/Postgres
  // backends), never synchronous throws out of a Promise-returning signature.
  async createAlertRule(input: CreateAlertRuleInput): Promise<AlertRuleRecord> {
    const record = newAlertRuleRecord(input, this.#now);
    this.#records.set(record.id, record);
    return record;
  }

  async listAlertRules(ref: TenantRef): Promise<readonly AlertRuleRecord[]> {
    const safe = validateTenantRefSlugs(ref);
    return [...this.#records.values()]
      .filter((record) => matchesTenant(record, safe))
      .sort(compareAlertRules);
  }

  async getAlertRule(ref: TenantRef, id: string): Promise<AlertRuleRecord | undefined> {
    const safe = validateTenantRefSlugs(ref);
    const record = this.#records.get(validateAlertRuleId(id));
    return record !== undefined && matchesTenant(record, safe) ? record : undefined;
  }

  async deleteAlertRule(ref: TenantRef, id: string): Promise<boolean> {
    const safe = validateTenantRefSlugs(ref);
    const record = this.#records.get(validateAlertRuleId(id));
    if (record === undefined || !matchesTenant(record, safe)) return false;
    this.#records.delete(record.id);
    return true;
  }

  async listEnabledAlertRules(): Promise<readonly AlertRuleRecord[]> {
    return [...this.#records.values()].filter((record) => record.enabled);
  }

  async updateAlertFiringState(
    id: string,
    state: AlertFiringState,
  ): Promise<AlertRuleRecord | undefined> {
    const record = this.#records.get(validateAlertRuleId(id));
    if (record === undefined) return undefined;
    const updated = withFiringState(record, state);
    this.#records.set(record.id, updated);
    return updated;
  }
}

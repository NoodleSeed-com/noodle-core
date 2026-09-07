import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeployAuthGate } from '@noodle-borg/control-plane/portable';
import { readJsonBody, sendJson } from '@noodle-borg/transport-http';
import { AlertRuleResponseSchema, AlertRulesListResponseSchema } from '@noodle-borg/wire-contracts';
import {
  buildAlertWebhookPayload,
  deliverAlertWebhook,
  validateAlertWebhookUrl,
} from '../alert-webhook.js';
import { sendForbidden } from '../http-util.js';
import {
  ALERT_METRICS,
  ALERT_WINDOWS_MINUTES,
  type AlertMetric,
  type AlertRuleRecord,
  type AlertRuleStore,
  type AlertWindowMinutes,
  MAX_ALERT_RULES_PER_ENV,
} from '../store/alert-rules.js';
import type { AuditSink } from '../store/audit.js';
import type { ControlPlaneStore, TenantRef } from '../store.js';
import { sendContract } from './apps.js';
import { authorizeControlPlane, authorizeTenantControl } from './control-plane.js';
import { canManageMembers } from './org-admin.js';

/**
 * Analytics alerting routes (E2, ADR 0130): `GET`/`POST .../alerts`, `DELETE .../alerts/{id}`,
 * and `POST .../alerts/{id}/test`. Reads are org-MEMBER gated (`authorizeTenantControl`, like the
 * neighbouring analytics reads); mutations and test-fires are org-OWNER gated (`canManageMembers`,
 * like the GHD-1 connection writes) and emit audit events with scalar details only.
 *
 * The webhook URL enters once through `POST` (validated by `validateAlertWebhookUrl`) and never
 * leaves again: responses serialize rules through {@link publicAlertRule} and the strict Zod
 * contract has no field that could carry it.
 */

export interface AlertRouteDeps {
  readonly gate: DeployAuthGate;
  readonly controlPlane: ControlPlaneStore;
  readonly store: AlertRuleStore;
  readonly audit: AuditSink;
  readonly maxBody: number;
  /** Dev/test-only loopback webhook carve-out (`alertWebhookAllowLoopback`). */
  readonly allowLoopbackWebhooks: boolean;
  /** Injectable clock for deterministic test-fire timestamps. */
  readonly clock?: () => Date;
}

/** Redact a webhook URL to its origin — path/query (where tokens live) never leave the service. */
function redactWebhookUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return '<redacted>';
  }
}

/** The redacted public view of a rule; the only shape routes may serialize. */
function publicAlertRule(record: AlertRuleRecord): Record<string, unknown> {
  return {
    id: record.id,
    ...(record.name !== undefined ? { name: record.name } : {}),
    metric: record.metric,
    threshold: record.threshold,
    windowMinutes: record.windowMinutes,
    comparison: record.comparison,
    webhook: redactWebhookUrl(record.webhookUrl),
    enabled: record.enabled,
    cooldownMinutes: record.cooldownMinutes,
    breaching: record.breaching,
    ...(record.lastObserved !== undefined ? { lastObserved: record.lastObserved } : {}),
    ...(record.lastFiredAt !== undefined ? { lastFiredAt: record.lastFiredAt } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** `GET` (member) / `POST` (owner) on the alert-rule collection. */
export async function handleAlertRules(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  deps: AlertRouteDeps,
): Promise<void> {
  if (req.method === 'GET') {
    const identity = await authorizeTenantControl(req, res, deps.gate, deps.controlPlane, ref.org);
    if (identity === false) return;
    const rules = await deps.store.listAlertRules(ref);
    return sendContract(res, () =>
      AlertRulesListResponseSchema.parse({ ok: true, data: { rules: rules.map(publicAlertRule) } }),
    );
  }
  if (req.method === 'POST') return handleCreate(req, res, ref, deps);
  return sendJson(res, 404, { error: 'not found' });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  deps: AlertRouteDeps,
): Promise<void> {
  const identity = await authorizeOwner(req, res, ref, deps);
  if (identity === undefined) return;
  const body = await readJsonBody(req, deps.maxBody);
  if (!body.ok) return sendJson(res, body.status, { error: body.error });
  const parsed = body.value as {
    name?: unknown;
    metric?: unknown;
    threshold?: unknown;
    windowMinutes?: unknown;
    webhookUrl?: unknown;
    enabled?: unknown;
    cooldownMinutes?: unknown;
  };
  if (
    typeof parsed.metric !== 'string' ||
    !(ALERT_METRICS as readonly string[]).includes(parsed.metric)
  ) {
    return sendJson(res, 400, {
      error: `"metric" must be one of ${ALERT_METRICS.join(', ')}`,
    });
  }
  if (
    typeof parsed.threshold !== 'number' ||
    !Number.isFinite(parsed.threshold) ||
    parsed.threshold < 0
  ) {
    return sendJson(res, 400, { error: '"threshold" must be a finite number >= 0' });
  }
  if (
    typeof parsed.windowMinutes !== 'number' ||
    !(ALERT_WINDOWS_MINUTES as readonly number[]).includes(parsed.windowMinutes)
  ) {
    return sendJson(res, 400, {
      error: `"windowMinutes" must be one of ${ALERT_WINDOWS_MINUTES.join(', ')}`,
    });
  }
  if (
    parsed.name !== undefined &&
    (typeof parsed.name !== 'string' || parsed.name.length === 0 || parsed.name.length > 100)
  ) {
    return sendJson(res, 400, { error: '"name" must be a string of 1-100 characters' });
  }
  if (
    parsed.cooldownMinutes !== undefined &&
    (typeof parsed.cooldownMinutes !== 'number' ||
      !Number.isInteger(parsed.cooldownMinutes) ||
      parsed.cooldownMinutes < 1 ||
      parsed.cooldownMinutes > 24 * 60)
  ) {
    return sendJson(res, 400, { error: '"cooldownMinutes" must be an integer from 1 to 1440' });
  }
  if (parsed.enabled !== undefined && typeof parsed.enabled !== 'boolean') {
    return sendJson(res, 400, { error: '"enabled" must be a boolean' });
  }
  if (typeof parsed.webhookUrl !== 'string') {
    return sendJson(res, 400, { error: '"webhookUrl" must be a string' });
  }
  const webhook = validateAlertWebhookUrl(parsed.webhookUrl, {
    allowLoopback: deps.allowLoopbackWebhooks,
  });
  if (!webhook.ok) return sendJson(res, 400, { error: webhook.error });

  // Soft abuse cap, checked read-then-write: two concurrent owner creates can overshoot by a
  // request or two, which is acceptable for a bound whose only job is preventing webhook floods —
  // a hard transactional cap is not worth a table lock here (unlike the GHD-1 uniqueness rules).
  const existing = await deps.store.listAlertRules(ref);
  if (existing.length >= MAX_ALERT_RULES_PER_ENV) {
    return sendJson(res, 409, {
      error: `alert rule limit reached (${MAX_ALERT_RULES_PER_ENV} per environment); remove one first`,
    });
  }

  const record = await deps.store.createAlertRule({
    orgSlug: ref.org,
    appSlug: ref.app,
    environment: ref.env,
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    metric: parsed.metric as AlertMetric,
    threshold: parsed.threshold,
    windowMinutes: parsed.windowMinutes as AlertWindowMinutes,
    webhookUrl: parsed.webhookUrl,
    ...(parsed.enabled !== undefined ? { enabled: parsed.enabled } : {}),
    ...(parsed.cooldownMinutes !== undefined ? { cooldownMinutes: parsed.cooldownMinutes } : {}),
    createdBySubject: identity.subject,
  });
  // Audit details are scalar-only and NEVER include the webhook URL or its host.
  await deps.audit.emit({
    eventType: 'alert.rule.created',
    org: ref.org,
    app: ref.app,
    env: ref.env,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      ruleId: record.id,
      metric: record.metric,
      threshold: record.threshold,
      windowMinutes: record.windowMinutes,
    },
  });
  return sendContract(res, () =>
    AlertRuleResponseSchema.parse({ ok: true, data: publicAlertRule(record) }),
  );
}

/** `DELETE .../alerts/{id}` — org OWNER only; 404 when the rule is not in this tenant scope. */
export async function handleAlertRuleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  id: string,
  deps: AlertRouteDeps,
): Promise<void> {
  const identity = await authorizeOwner(req, res, ref, deps);
  if (identity === undefined) return;
  const deleted = await deps.store.deleteAlertRule(ref, id);
  if (!deleted) return sendJson(res, 404, { error: 'not found' });
  await deps.audit.emit({
    eventType: 'alert.rule.deleted',
    org: ref.org,
    app: ref.app,
    env: ref.env,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: { ruleId: id },
  });
  return sendJson(res, 200, { ok: true, data: { deleted: true } });
}

/**
 * `POST .../alerts/{id}/test` — org OWNER only: sends a synthetic `event: "test"` payload through
 * the exact guarded delivery path a real breach uses. The response carries only the closed-code
 * delivery outcome; a failed delivery is still a 200 (the route worked, the endpoint did not).
 */
export async function handleAlertRuleTest(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  id: string,
  deps: AlertRouteDeps,
): Promise<void> {
  const identity = await authorizeOwner(req, res, ref, deps);
  if (identity === undefined) return;
  const rule = await deps.store.getAlertRule(ref, id);
  if (rule === undefined) return sendJson(res, 404, { error: 'not found' });
  const firedAt = (deps.clock?.() ?? new Date()).toISOString();
  const payload = buildAlertWebhookPayload(rule, 'test', rule.lastObserved ?? 0, firedAt);
  const delivery = await deliverAlertWebhook(rule.webhookUrl, payload, {
    allowLoopback: deps.allowLoopbackWebhooks,
  });
  await deps.audit.emit({
    eventType: 'alert.rule.test_fired',
    org: ref.org,
    app: ref.app,
    env: ref.env,
    decision: 'allow',
    status: 200,
    actorSubject: identity.subject,
    ...(identity.email !== undefined ? { actorEmail: identity.email } : {}),
    details: {
      ruleId: rule.id,
      delivered: delivery.delivered,
      ...(delivery.status !== undefined ? { httpStatus: delivery.status } : {}),
      ...(delivery.reason !== undefined ? { reason: delivery.reason } : {}),
    },
  });
  return sendJson(res, 200, { ok: true, data: { delivery } });
}

/** Owner gate shared by every alert mutation (mirrors the GHD-1 write posture). */
async function authorizeOwner(
  req: IncomingMessage,
  res: ServerResponse,
  ref: TenantRef,
  deps: AlertRouteDeps,
): Promise<{ subject: string; email?: string } | undefined> {
  const identity = await authorizeControlPlane(req, res, deps.gate, { requireIdentity: true });
  if (identity === false) return undefined;
  if (!(await canManageMembers(deps.controlPlane, ref.org, identity))) {
    sendForbidden(res, 'forbidden');
    return undefined;
  }
  return identity;
}
